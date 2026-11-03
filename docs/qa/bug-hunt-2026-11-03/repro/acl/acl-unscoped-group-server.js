// acl (server): admin.saveGroup refuses to give an unscoped (legacy) permission
// group a Flight Program, contrary to docs/flight-program-access.md step 5.
process.argv = [process.argv[0], __filename, "convex/zz-bughunt-unscoped-group.test.ts",
  "admin.saveGroup cannot assign an unscoped legacy permission group to a Flight Program"];
require("./server-repro.js");
