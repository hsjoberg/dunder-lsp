const getDb = require("../dist/db/db").default;

(async () => {
  const db = await getDb();

  const pubkey = process.argv[2];
  const name = process.argv[3];

  if (!pubkey) {
    console.log(`USAGE:\n   create-admin.js pubkey [name]`);
    process.exit(0);
  }

  await db.run("INSERT INTO admin (pubkey, name) VALUES ($pubkey, $name)", {
    $pubkey: pubkey,
    $name: name ?? "Admin",
  });

  console.log("Done");
})();
