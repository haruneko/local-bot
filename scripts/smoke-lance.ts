import { createApp } from "../src/app/bootstrap.js";

await createApp({ verbose: false });
console.log("OK: LanceDB opened");
