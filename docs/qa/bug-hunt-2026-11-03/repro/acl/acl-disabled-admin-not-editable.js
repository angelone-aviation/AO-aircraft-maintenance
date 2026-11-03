// acl (server): the only active system administrator cannot edit, demote or
// rename a DISABLED administrator: admin.updateUser throws
// "Keep at least one active administrator."
require("child_process");
process.argv = [process.argv[0], __filename, "convex/zz-bughunt-disabled-admin.test.ts",
  "admin.updateUser refuses to change a disabled administrator while exactly one administrator is active"];
require("./server-repro.js");
