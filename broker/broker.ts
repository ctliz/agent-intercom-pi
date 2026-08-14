// Autostart entry point for the broker process. The broker implementation and
// the internal lifecycle-emission observer seam live in `./broker-impl.ts`,
// which is a private implementation module not exposed via the package exports
// map.
import { IntercomBroker } from "./broker-impl.ts";

new IntercomBroker().start();
