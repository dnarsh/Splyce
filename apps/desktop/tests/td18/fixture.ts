import { mount } from "svelte";
import Td18Fixture from "./Td18Fixture.svelte";

const target = document.getElementById("app");
if (target) {
  mount(Td18Fixture, { target });
}
