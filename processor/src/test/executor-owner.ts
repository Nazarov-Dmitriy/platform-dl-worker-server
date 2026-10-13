import { LeaseClock } from "../lease.js";
import { Executor } from "../executor.js";
const lease = new LeaseClock();
lease.sent("x");
lease.grant("x", 120, 5);
const executor = new Executor(60000, lease, () => {});
process.send?.({ pid: executor.child.pid });
