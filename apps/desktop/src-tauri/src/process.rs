use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const MAX_FRAME_BYTES: usize = 256 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const PI_REVISION: &str = "d5b3de22d0e24a3e9c38a9410d3329b099717283";

#[derive(Debug)]
pub struct EngineError {
    pub code: &'static str,
    message: &'static str,
    source: Option<std::io::Error>,
}

impl EngineError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            source: None,
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source as &dyn std::error::Error)
    }
}

fn io_error(source: std::io::Error) -> EngineError {
    let mut error = EngineError::new("ENGINE_IO", "Engine transport or resource access failed");
    error.source = Some(source);
    error
}

fn invalid_manifest() -> EngineError {
    EngineError::new(
        "ENGINE_IDENTITY",
        "Packaged engine identity verification failed",
    )
}

fn bootstrap_request(app_data_dir: &Path) -> Result<Value, EngineError> {
    let path = app_data_dir
        .to_str()
        .filter(|path| !path.contains('\0'))
        .ok_or_else(|| EngineError::new("ENGINE_START", "Invalid application data directory"))?;
    #[cfg(windows)]
    let path = {
        let path = path.strip_prefix(r"\\?\").unwrap_or(path);
        let bytes = path.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'\\' | b'/')
        {
            return Err(EngineError::new(
                "ENGINE_START",
                "Invalid application data directory",
            ));
        }
        path
    };
    #[cfg(not(windows))]
    if !app_data_dir.is_absolute() {
        return Err(EngineError::new(
            "ENGINE_START",
            "Invalid application data directory",
        ));
    }
    Ok(
        serde_json::json!({"id":"native-bootstrap","method":"native.bootstrap","params":{"appDataDir":path}}),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    pi_revision: String,
    files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    path: String,
    sha256: String,
}

fn digest_matches(bytes: &[u8], expected: &str) -> bool {
    hash_matches(&Sha256::digest(bytes), expected)
}

fn hash_matches(hash: &[u8], expected: &str) -> bool {
    expected.len() == hash.len() * 2
        && expected
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .zip(hash)
            .all(|(hex, byte)| {
                char::from(hex[0])
                    .to_digit(16)
                    .zip(char::from(hex[1]).to_digit(16))
                    .is_some_and(|(hi, lo)| ((hi << 4) | lo) as u8 == *byte)
            })
}

fn relative_path(value: &str) -> Result<PathBuf, EngineError> {
    if value.is_empty()
        || value.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with('.')
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-@".contains(&byte))
                || matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
    {
        return Err(invalid_manifest());
    }
    Ok(value.split('/').collect())
}

fn reject_link(path: &Path) -> Result<(), EngineError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid_manifest());
        }
    }
    if metadata.file_type().is_symlink() {
        return Err(invalid_manifest());
    }
    Ok(())
}

fn locked_file(path: &Path, directory: bool) -> Result<File, EngineError> {
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ,
        };
        options.share_mode(FILE_SHARE_READ);
        if directory {
            options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
        }
    }
    #[cfg(not(windows))]
    let _ = directory;
    options.open(path).map_err(io_error)
}

fn verify_bundle(root: &Path, expected_digest: &str) -> Result<(PathBuf, Vec<File>), EngineError> {
    reject_link(root)?;
    let root = fs::canonicalize(root).map_err(io_error)?;
    let mut locks = vec![locked_file(&root, true)?];
    let manifest_path = root.join("manifest.json");
    reject_link(&manifest_path)?;
    let mut manifest_file = locked_file(&manifest_path, false)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut manifest_file)
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES || !digest_matches(&bytes, expected_digest) {
        return Err(invalid_manifest());
    }
    locks.push(manifest_file);
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| invalid_manifest())?;
    if manifest.schema_version != 1
        || manifest.pi_revision != PI_REVISION
        || manifest.files.is_empty()
    {
        return Err(invalid_manifest());
    }
    let mut selected = HashSet::new();
    let mut directories = HashSet::new();
    for entry in manifest.files {
        let relative = relative_path(&entry.path)?;
        if entry.path.eq_ignore_ascii_case("manifest.json")
            || !selected.insert(entry.path.to_ascii_lowercase())
        {
            return Err(invalid_manifest());
        }
        let mut current = root.clone();
        for component in relative.components() {
            current.push(component);
            reject_link(&current)?;
            if current != root.join(&relative) && directories.insert(current.clone()) {
                locks.push(locked_file(&current, true)?);
            }
        }
        if !fs::canonicalize(&current)
            .map_err(io_error)?
            .starts_with(&root)
        {
            return Err(invalid_manifest());
        }
        let mut file = locked_file(&current, false)?;
        if !file.metadata().map_err(io_error)?.is_file() {
            return Err(invalid_manifest());
        }
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if !hash_matches(&hash.finalize(), &entry.sha256) {
            return Err(invalid_manifest());
        }
        locks.push(file);
    }
    if !selected.contains("node.exe") || !selected.contains("host.mjs") {
        return Err(invalid_manifest());
    }
    let mut pending = vec![root.clone()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            reject_link(&entry.path())?;
            if entry.file_type().map_err(io_error)?.is_dir() {
                if !directories.contains(&entry.path()) {
                    return Err(invalid_manifest());
                }
                pending.push(entry.path());
            } else {
                let relative = entry
                    .path()
                    .strip_prefix(&root)
                    .map_err(|_| invalid_manifest())?
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_ascii_lowercase();
                if relative != "manifest.json" && !selected.contains(&relative) {
                    return Err(invalid_manifest());
                }
            }
        }
    }
    Ok((root, locks))
}

fn encode_frame(value: &Value) -> Result<Vec<u8>, EngineError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| EngineError::new("ENGINE_FRAME", "Invalid engine frame"))?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES - 4 {
        return Err(EngineError::new(
            "ENGINE_FRAME",
            "Engine frame exceeds the transport limit",
        ));
    }
    let mut frame = Vec::with_capacity(bytes.len() + 4);
    frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    frame.extend_from_slice(&bytes);
    Ok(frame)
}

fn read_frame(reader: &mut impl Read) -> Result<(Value, usize), EngineError> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header).map_err(io_error)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES - 4 {
        return Err(EngineError::new(
            "ENGINE_FRAME",
            "Invalid engine frame length",
        ));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(io_error)?;
    serde_json::from_slice(&bytes)
        .map(|value| (value, length + 4))
        .map_err(|_| EngineError::new("ENGINE_FRAME", "Invalid engine response JSON"))
}

#[cfg(windows)]
pub use windows::{EngineChild, EngineEvents};

#[cfg(windows)]
mod windows {
    use super::*;
    use std::collections::VecDeque;
    use std::ffi::{c_void, OsStr};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::*;

    fn wide(value: &OsStr) -> Result<Vec<u16>, EngineError> {
        let mut result: Vec<u16> = value.encode_wide().collect();
        if result.contains(&0) {
            return Err(invalid_manifest());
        }
        result.push(0);
        Ok(result)
    }

    fn checked(value: i32) -> Result<(), EngineError> {
        if value == 0 {
            Err(io_error(std::io::Error::last_os_error()))
        } else {
            Ok(())
        }
    }

    fn launch_path(path: &Path) -> Result<Vec<u16>, EngineError> {
        use std::path::{Component, Prefix};
        let mut value = wide(path.as_os_str())?;
        match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                // Node's entrypoint realpath does not accept a verbatim working directory.
                Prefix::VerbatimDisk(_) => {
                    value.drain(..4);
                }
                Prefix::Disk(_) => {}
                _ => return Err(invalid_manifest()),
            },
            _ => return Err(invalid_manifest()),
        }
        Ok(value)
    }

    fn own(handle: HANDLE) -> Result<OwnedHandle, EngineError> {
        if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            Err(io_error(std::io::Error::last_os_error()))
        } else {
            // SAFETY: successful Win32 creation returns a new uniquely owned handle.
            Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
        }
    }

    fn pipe(parent_reads: bool) -> Result<(OwnedHandle, OwnedHandle), EngineError> {
        let security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let (mut read, mut write) = (null_mut(), null_mut());
        // SAFETY: both outputs and the security structure live through the call.
        unsafe {
            checked(CreatePipe(&mut read, &mut write, &security, 0))?;
        }
        let (read, write) = (own(read)?, own(write)?);
        let parent = if parent_reads { &read } else { &write };
        // SAFETY: parent is an owned valid pipe handle; only its inheritance bit changes.
        unsafe {
            checked(SetHandleInformation(
                parent.as_raw_handle(),
                HANDLE_FLAG_INHERIT,
                0,
            ))?;
        }
        Ok((read, write))
    }

    struct Attributes {
        _storage: Vec<usize>,
        pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
    }

    impl Attributes {
        fn new(handles: &[HANDLE], jobs: &[HANDLE]) -> Result<Self, EngineError> {
            let mut bytes = 0;
            // SAFETY: the first call only obtains the required allocation size.
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
            }
            if bytes == 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let pointer = storage.as_mut_ptr().cast();
            // SAFETY: usize storage provides alignment and the queried byte capacity.
            unsafe {
                checked(InitializeProcThreadAttributeList(pointer, 2, 0, &mut bytes))?;
            }
            let result = Self {
                _storage: storage,
                pointer,
            };
            // SAFETY: handles remain live until CreateProcessW completes.
            unsafe {
                checked(UpdateProcThreadAttribute(
                    pointer,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    handles.as_ptr().cast(),
                    size_of_val(handles),
                    null_mut(),
                    null(),
                ))?;
                checked(UpdateProcThreadAttribute(
                    pointer,
                    0,
                    PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                    jobs.as_ptr().cast(),
                    size_of_val(jobs),
                    null_mut(),
                    null(),
                ))?;
            }
            Ok(result)
        }
    }

    impl Drop for Attributes {
        fn drop(&mut self) {
            // SAFETY: this is the initialized list and its backing storage is still live.
            unsafe {
                DeleteProcThreadAttributeList(self.pointer);
            }
        }
    }

    #[derive(Clone, Copy, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TransportLimits {
        pending_queue_max_frames: usize,
        pending_queue_max_bytes: usize,
        renderer_max_frames: usize,
        renderer_max_bytes: usize,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BridgeProtocol {
        transport_limits: TransportLimits,
    }

    struct EventQueue {
        frames: VecDeque<(Value, usize)>,
        bytes: usize,
        terminal: Option<(&'static str, &'static str)>,
    }

    type SharedEvents = Arc<(Mutex<EventQueue>, Condvar)>;

    #[derive(Clone)]
    pub struct EngineEvents {
        shared: SharedEvents,
        renderer_max_frames: usize,
        renderer_max_bytes: usize,
    }

    impl EngineEvents {
        pub fn drain(&self) -> Result<Vec<Value>, EngineError> {
            let (mutex, wake) = &*self.shared;
            let mut queue = mutex.lock().map_err(|_| {
                EngineError::new("ENGINE_CLEANUP", "Engine event queue is unavailable")
            })?;
            let mut frames = Vec::new();
            let mut bytes = 0;
            while let Some((_, size)) = queue.frames.front() {
                if frames.len() == self.renderer_max_frames
                    || bytes + size > self.renderer_max_bytes
                {
                    break;
                }
                let (frame, size) = queue.frames.pop_front().expect("front was present");
                queue.bytes -= size;
                bytes += size;
                frames.push(frame);
            }
            if !frames.is_empty() {
                wake.notify_one();
                return Ok(frames);
            }
            if let Some((code, message)) = queue.terminal {
                return Err(EngineError::new(code, message));
            }
            Ok(frames)
        }

        #[cfg(test)]
        pub fn pending_for_test(&self) -> (usize, usize) {
            let queue = self.shared.0.lock().expect("event queue is available");
            (queue.frames.len(), queue.bytes)
        }
    }

    fn close_events(shared: &SharedEvents, code: &'static str, message: &'static str) {
        let (mutex, wake) = &**shared;
        if let Ok(mut queue) = mutex.lock() {
            queue.terminal.get_or_insert((code, message));
            wake.notify_all();
        }
    }

    pub struct EngineChild {
        process: OwnedHandle,
        job: OwnedHandle,
        pid: u32,
        writes: Option<mpsc::SyncSender<Vec<u8>>>,
        acknowledgements: mpsc::Receiver<Result<(), EngineError>>,
        responses: mpsc::Receiver<Result<Value, EngineError>>,
        read_resume: Option<mpsc::Sender<()>>,
        events: EngineEvents,
        failed: Arc<AtomicBool>,
        workers: Vec<JoinHandle<()>>,
        stopped: bool,
        _verified_files: Vec<File>,
    }

    impl EngineChild {
        pub fn spawn(
            engine_dir: &Path,
            expected_manifest_digest: &str,
            app_data_dir: &Path,
        ) -> Result<Self, EngineError> {
            let bootstrap = bootstrap_request(app_data_dir)?;
            let (root, verified_files) = verify_bundle(engine_dir, expected_manifest_digest)?;
            let executable = launch_path(&root.join("node.exe"))?;
            let cwd = launch_path(&root)?;
            let mut command = wide(OsStr::new("node.exe host.mjs"))?;
            let mut system_root = vec![0u16; 32768];
            // SAFETY: the writable UTF-16 buffer has the stated capacity.
            let count = unsafe {
                windows_sys::Win32::System::SystemInformation::GetSystemWindowsDirectoryW(
                    system_root.as_mut_ptr(),
                    system_root.len() as u32,
                )
            } as usize;
            if count == 0 || count >= system_root.len() {
                return Err(invalid_manifest());
            }
            let mut environment: Vec<u16> = "SystemRoot=".encode_utf16().collect();
            environment.extend_from_slice(&system_root[..count]);
            environment.push(0);
            environment.push(0);
            let (stdin_read, stdin_write) = pipe(false)?;
            let (stdout_read, stdout_write) = pipe(true)?;
            let stderr = File::options().write(true).open("NUL").map_err(io_error)?;
            // SAFETY: stderr is a valid handle retained until process creation finishes.
            unsafe {
                checked(SetHandleInformation(
                    stderr.as_raw_handle(),
                    HANDLE_FLAG_INHERIT,
                    HANDLE_FLAG_INHERIT,
                ))?;
            }
            let inherited = [
                stdin_read.as_raw_handle(),
                stdout_write.as_raw_handle(),
                stderr.as_raw_handle(),
            ];
            // SAFETY: CreateJobObjectW creates a new unnamed job without borrowed arguments.
            let job = own(unsafe { CreateJobObjectW(null(), null()) })?;
            // SAFETY: zero is the documented initial state for these Win32 POD structures.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: job and limits are valid and the size matches the selected information class.
            unsafe {
                checked(SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of_val(&limits) as u32,
                ))?;
            }
            let jobs = [job.as_raw_handle()];
            let attributes = Attributes::new(&inherited, &jobs)?;
            // SAFETY: startup and process information are initialized according to Win32.
            let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdin_read.as_raw_handle();
            startup.StartupInfo.hStdOutput = stdout_write.as_raw_handle();
            startup.StartupInfo.hStdError = stderr.as_raw_handle();
            startup.lpAttributeList = attributes.pointer;
            let mut information: PROCESS_INFORMATION = unsafe { zeroed() };
            // SAFETY: all wide strings, environment and inherited handles outlive the call.
            unsafe {
                checked(CreateProcessW(
                    executable.as_ptr(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    CREATE_SUSPENDED
                        | CREATE_NO_WINDOW
                        | CREATE_UNICODE_ENVIRONMENT
                        | EXTENDED_STARTUPINFO_PRESENT,
                    environment.as_ptr().cast::<c_void>(),
                    cwd.as_ptr(),
                    &startup.StartupInfo,
                    &mut information,
                ))?;
            }
            let process = own(information.hProcess)?;
            let main_thread = own(information.hThread)?;
            drop(stdin_read);
            drop(stdout_write);
            drop(stderr);
            let (writes, write_queue) = mpsc::sync_channel::<Vec<u8>>(1);
            let (acknowledge, acknowledgements) = mpsc::sync_channel(1);
            let (reply, responses) = mpsc::sync_channel(1);
            let (read_resume, resume_reads) = mpsc::channel();
            let protocol: BridgeProtocol = serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/splyce-pi/dist/bridge-protocol.json"
            )))
            .map_err(|_| EngineError::new("ENGINE_FRAME", "Invalid bridge transport limits"))?;
            let bounds = protocol.transport_limits;
            if bounds.pending_queue_max_frames == 0
                || bounds.pending_queue_max_bytes < MAX_FRAME_BYTES
                || bounds.renderer_max_frames == 0
                || bounds.renderer_max_bytes < MAX_FRAME_BYTES
            {
                return Err(EngineError::new(
                    "ENGINE_FRAME",
                    "Invalid bridge transport limits",
                ));
            }
            let events = EngineEvents {
                shared: Arc::new((
                    Mutex::new(EventQueue {
                        frames: VecDeque::new(),
                        bytes: 0,
                        terminal: None,
                    }),
                    Condvar::new(),
                )),
                renderer_max_frames: bounds.renderer_max_frames,
                renderer_max_bytes: bounds.renderer_max_bytes,
            };
            let reader_events = events.shared.clone();
            let failed = Arc::new(AtomicBool::new(false));
            let reader_failed = failed.clone();
            let reader = std::thread::Builder::new()
                .name("splyce-engine-read".into())
                .spawn(move || {
                    let mut output = File::from(stdout_read);
                    loop {
                        match read_frame(&mut output) {
                            Ok((frame, size))
                                if frame.as_object().is_some_and(|object| {
                                    object.len() == 1
                                        && object.get("event").is_some_and(Value::is_object)
                                }) =>
                            {
                                let (mutex, wake) = &*reader_events;
                                let mut queue = match mutex.lock() {
                                    Ok(queue) => queue,
                                    Err(_) => break,
                                };
                                while queue.terminal.is_none()
                                    && (queue.frames.len() >= bounds.pending_queue_max_frames
                                        || queue.bytes + size > bounds.pending_queue_max_bytes)
                                {
                                    queue = match wake.wait(queue) {
                                        Ok(queue) => queue,
                                        Err(_) => return,
                                    };
                                }
                                if queue.terminal.is_some() {
                                    break;
                                }
                                queue.frames.push_back((frame["event"].clone(), size));
                                queue.bytes += size;
                            }
                            Ok((frame, _))
                                if frame.get("id").and_then(Value::as_str).is_some()
                                    && frame.get("ok").and_then(Value::as_bool).is_some()
                                    && frame.get("event").is_none() =>
                            {
                                if reply.try_send(Ok(frame)).is_err() {
                                    close_events(
                                        &reader_events,
                                        "ENGINE_FRAME",
                                        "Unsolicited engine reply",
                                    );
                                    reader_failed.store(true, Ordering::Release);
                                    break;
                                }
                                if resume_reads.recv().is_err() {
                                    break;
                                }
                            }
                            result => {
                                let error = match result {
                                    Err(error) => error,
                                    Ok(_) => {
                                        EngineError::new("ENGINE_FRAME", "Unknown engine frame")
                                    }
                                };
                                close_events(&reader_events, error.code, error.message);
                                let _ = reply.try_send(Err(error));
                                reader_failed.store(true, Ordering::Release);
                                break;
                            }
                        }
                    }
                })
                .map_err(io_error)?;
            let writer = std::thread::Builder::new()
                .name("splyce-engine-write".into())
                .spawn(move || {
                    let mut input = File::from(stdin_write);
                    while let Ok(frame) = write_queue.recv() {
                        let result = input
                            .write_all(&frame)
                            .and_then(|_| input.flush())
                            .map_err(io_error);
                        let terminal = result.is_err();
                        if acknowledge.try_send(result).is_err() || terminal {
                            break;
                        }
                    }
                })
                .map_err(io_error)?;
            let mut child = Self {
                process,
                job,
                pid: information.dwProcessId,
                writes: Some(writes),
                acknowledgements,
                responses,
                read_resume: Some(read_resume),
                events,
                failed,
                workers: vec![reader, writer],
                stopped: false,
                _verified_files: verified_files,
            };
            // SAFETY: the owned primary thread belongs to the now-contained suspended child.
            if unsafe { ResumeThread(main_thread.as_raw_handle()) } == u32::MAX {
                child.stop()?;
                return Err(EngineError::new("ENGINE_START", "Engine could not start"));
            }
            let response = child.request(&bootstrap)?;
            if response
                != serde_json::json!({"id":"native-bootstrap","ok":true,"value":{"state":"initialized"}})
            {
                child.stop()?;
                return Err(EngineError::new("ENGINE_START", "Engine bootstrap failed"));
            }
            Ok(child)
        }

        pub fn pid(&self) -> u32 {
            self.pid
        }

        pub fn events(&self) -> EngineEvents {
            self.events.clone()
        }

        pub fn is_running(&self) -> bool {
            // SAFETY: querying an owned process with a zero timeout has no side effects.
            !self.stopped
                && unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } == WAIT_TIMEOUT
        }

        pub fn request(&mut self, value: &Value) -> Result<Value, EngineError> {
            self.request_with_response(value, |_| true)
        }

        pub fn request_with_response(
            &mut self,
            value: &Value,
            on_response: impl FnOnce(&Value) -> bool,
        ) -> Result<Value, EngineError> {
            let id = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    EngineError::new("ENGINE_FRAME", "Engine request identity is missing")
                })?;
            let frame = encode_frame(value)?;
            if !self.is_running() || self.failed.load(Ordering::Acquire) {
                self.stop()?;
                return Err(EngineError::new("ENGINE_EXITED", "Engine is disconnected"));
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            let result = (|| {
                self.writes
                    .as_ref()
                    .ok_or_else(|| EngineError::new("ENGINE_EXITED", "Engine is disconnected"))?
                    .try_send(frame)
                    .map_err(|_| {
                        EngineError::new(
                            "ENGINE_BACKPRESSURE",
                            "Engine request queue is unavailable",
                        )
                    })?;
                self.acknowledgements
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .map_err(|_| {
                        EngineError::new(
                            "ENGINE_TIMEOUT",
                            "Engine request did not complete before its deadline",
                        )
                    })??;
                let response = self
                    .responses
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .map_err(|_| {
                        EngineError::new(
                            "ENGINE_TIMEOUT",
                            "Engine response did not arrive before its deadline",
                        )
                    })??;
                if response.get("id").and_then(Value::as_str) != Some(id) {
                    return Err(EngineError::new(
                        "ENGINE_FRAME",
                        "Engine response identity does not match its request",
                    ));
                }
                if !on_response(&response) {
                    return Err(EngineError::new(
                        "ENGINE_FRAME",
                        "Engine response was rejected",
                    ));
                }
                self.read_resume
                    .as_ref()
                    .ok_or_else(|| EngineError::new("ENGINE_EXITED", "Engine is disconnected"))?
                    .send(())
                    .map_err(|_| EngineError::new("ENGINE_EXITED", "Engine is disconnected"))?;
                Ok(response)
            })();
            if result.is_err() {
                self.stop()?;
            }
            result
        }

        pub fn stop(&mut self) -> Result<(), EngineError> {
            if self.stopped {
                return Ok(());
            }
            self.writes.take();
            self.read_resume.take();
            close_events(
                &self.events.shared,
                "ENGINE_EXITED",
                "Engine is disconnected",
            );
            let deadline = Instant::now() + Duration::from_secs(5);
            // SAFETY: handles remain owned; the short grace period permits EOF shutdown.
            unsafe {
                let wait = WaitForSingleObject(self.process.as_raw_handle(), 250);
                if wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT {
                    return Err(EngineError::new(
                        "ENGINE_CLEANUP",
                        "Engine shutdown status is unknown",
                    ));
                }
                checked(TerminateJobObject(self.job.as_raw_handle(), 1))?;
                if WaitForSingleObject(
                    self.process.as_raw_handle(),
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis() as u32,
                ) != WAIT_OBJECT_0
                {
                    return Err(EngineError::new(
                        "ENGINE_CLEANUP",
                        "Engine shutdown could not be confirmed",
                    ));
                }
            }
            loop {
                // SAFETY: zero initializes the job accounting output and the query uses its exact size.
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
                unsafe {
                    checked(QueryInformationJobObject(
                        self.job.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                        size_of_val(&accounting) as u32,
                        null_mut(),
                    ))?;
                }
                if accounting.ActiveProcesses == 0
                    && self.workers.iter().all(JoinHandle::is_finished)
                {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(EngineError::new(
                        "ENGINE_CLEANUP",
                        "Engine descendants or transport shutdown could not be confirmed",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            for worker in self.workers.drain(..) {
                if worker.join().is_err() {
                    return Err(EngineError::new(
                        "ENGINE_CLEANUP",
                        "Engine transport cleanup failed",
                    ));
                }
            }
            self.stopped = true;
            Ok(())
        }
    }

    impl Drop for EngineChild {
        fn drop(&mut self) {
            if let Err(error) = self.stop() {
                eprintln!("Engine cleanup failed: {}", error.code);
            }
            // Closing the owned kill-on-close job remains the final containment backstop.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_uses_only_absolute_unicode_application_data_path() {
        let path = std::env::temp_dir().join("splyce-data");
        let request = bootstrap_request(&path).unwrap();
        assert_eq!(
            request,
            serde_json::json!({"id":"native-bootstrap","method":"native.bootstrap","params":{"appDataDir":path.to_str().unwrap().strip_prefix(r"\\?\").unwrap_or(path.to_str().unwrap())}})
        );
        assert!(bootstrap_request(Path::new("relative")).is_err());
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStringExt;
            let invalid =
                std::ffi::OsString::from_wide(&[b'C' as u16, b':' as u16, b'\\' as u16, 0xd800]);
            assert!(bootstrap_request(Path::new(&invalid)).is_err());
            for invalid in [
                r"\\server\share",
                r"\\?\UNC\server\share",
                r"\\.\device",
                r"\\?\GLOBALROOT\device",
                r"C:relative",
                r"\rooted",
                "C:\\bad\0path",
            ] {
                assert!(
                    bootstrap_request(Path::new(invalid)).is_err(),
                    "{invalid:?}"
                );
            }
            for valid in [r"C:\Users\data", r"C:/Users/data", r"\\?\C:\Users\data"] {
                assert!(bootstrap_request(Path::new(valid)).is_ok(), "{valid:?}");
            }
            assert_eq!(
                bootstrap_request(Path::new(r"\\?\C:\Users\data")).unwrap()["params"]["appDataDir"],
                r"C:\Users\data"
            );
        }
    }

    #[test]
    fn frames_round_trip_and_enforce_encoded_limit() {
        let value = serde_json::json!({"id":"one","ok":true,"value":null});
        assert_eq!(
            read_frame(&mut encode_frame(&value).unwrap().as_slice())
                .unwrap()
                .0,
            value
        );
        assert!(read_frame(&mut 0u32.to_be_bytes().as_slice()).is_err());
        assert!(read_frame(&mut (MAX_FRAME_BYTES as u32).to_be_bytes().as_slice()).is_err());
        assert!(read_frame(&mut [0, 0, 0, 2, b'{'].as_slice()).is_err());
        assert!(encode_frame(&Value::String("x".repeat(MAX_FRAME_BYTES))).is_err());
    }

    #[test]
    fn manifest_requires_trusted_digest_and_strict_schema() {
        let bytes = br#"{"schemaVersion":1,"piRevision":"pin","files":[]}"#;
        let digest: String = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert!(digest_matches(bytes, &digest));
        assert!(!digest_matches(br#"{}"#, &digest));
        assert!(!digest_matches(bytes, ""));
        assert!(serde_json::from_slice::<Manifest>(
            br#"{"schemaVersion":1,"piRevision":"pin","files":[],"extra":true}"#
        )
        .is_err());
    }

    #[test]
    fn manifest_paths_are_portable_and_contained() {
        assert_eq!(
            relative_path("lib/host-test.mjs").unwrap(),
            PathBuf::from("lib").join("host-test.mjs")
        );
        for path in [
            "",
            "/node.exe",
            "../node.exe",
            "a/../b",
            "a//b",
            "a\\b",
            "C:/x",
            "x:stream",
            "NUL.txt",
            "a/CON",
            "a.",
        ] {
            assert!(relative_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn bundle_checks_every_selected_byte_and_refuses_unlisted_resources() {
        let root = std::env::temp_dir().join(format!(
            "splyce-bundle-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("node.exe"), b"binary fixture").unwrap();
        fs::write(root.join("host.mjs"), b"host fixture").unwrap();
        let hex = |bytes: &[u8]| -> String {
            Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        };
        let manifest = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "piRevision": PI_REVISION, "files": [
                {"path": "node.exe", "sha256": hex(b"binary fixture")},
                {"path": "host.mjs", "sha256": hex(b"host fixture")}
            ]
        }))
        .unwrap();
        fs::write(root.join("manifest.json"), &manifest).unwrap();
        let expected = hex(&manifest);
        assert!(verify_bundle(&root, &expected).is_ok());
        fs::write(root.join("host.mjs"), b"different host").unwrap();
        assert!(verify_bundle(&root, &expected).is_err());
        let mut changed: Value = serde_json::from_slice(&manifest).unwrap();
        changed["files"][1]["sha256"] = Value::String(hex(b"different host"));
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        assert!(verify_bundle(&root, &expected).is_err());
        fs::write(root.join("manifest.json"), &manifest).unwrap();
        fs::write(root.join("host.mjs"), b"host fixture").unwrap();
        fs::write(root.join("unlisted.mjs"), b"unlisted").unwrap();
        assert!(verify_bundle(&root, &expected).is_err());
        fs::remove_file(root.join("unlisted.mjs")).unwrap();
        fs::create_dir(root.join("unlisted")).unwrap();
        assert!(verify_bundle(&root, &expected).is_err());
        fs::remove_dir(root.join("unlisted")).unwrap();
        fs::write(root.join("manifest.json"), b"{}").unwrap();
        assert!(verify_bundle(&root, &expected).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
