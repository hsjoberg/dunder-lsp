const fastify = require("fastify")();
const qrcode = require("qrcode-terminal");
const secp256k1 = require("secp256k1");
const getDb = require("../dist/db/db").default;
const {
  createLnUrlAuth,
  bytesToHexString,
  generateBytes,
  hexToUint8Array,
} = require("../dist/utils/common");

(async () => {
  const db = await getDb();

  const listen = process.argv[2];
  const host = process.argv[3];
  const useHttps = process.argv[4] === "true";
  const name = process.argv[5];
  if (!listen || !host) {
    console.log(
      `USAGE:\n   create-admin-lnurl-auth.js listen host [use https (true/false)] [name]`,
    );
    process.exit(0);
  }

  const ip = listen.split(":")[0];
  const port = Number.parseInt(listen.split(":")[1] ?? "8089");
  const k1 = bytesToHexString(await generateBytes(32));
  let consumed = false;

  fastify.get("/lnurl-auth", async (request, reply) => {
    const { key, sig, k1: callbackK1 } = request.query;
    if (
      consumed ||
      callbackK1 !== k1 ||
      typeof key !== "string" ||
      !/^(02|03)[0-9a-fA-F]{64}$/.test(key) ||
      typeof sig !== "string" ||
      !/^[0-9a-fA-F]+$/.test(sig)
    ) {
      reply.code(400);
      return { status: "ERROR", reason: "Invalid or expired LNURL-auth request" };
    }

    try {
      const signature = secp256k1.signatureImport(hexToUint8Array(sig));
      if (
        !secp256k1.ecdsaVerify(
          signature,
          hexToUint8Array(callbackK1),
          hexToUint8Array(key),
        )
      ) {
        reply.code(400);
        return { status: "ERROR", reason: "Invalid LNURL-auth signature" };
      }
    } catch {
      reply.code(400);
      return { status: "ERROR", reason: "Invalid LNURL-auth signature" };
    }

    // Consume the challenge before the first await so two callbacks cannot
    // race to provision different administrators.
    consumed = true;
    await db.run("INSERT INTO admin (pubkey, name) VALUES ($pubkey, $name)", {
      $pubkey: key,
      $name: name ?? "Admin",
    });
    reply.send({ status: "OK" });
    console.log("Done");
    process.exit(0);
  });

  fastify.listen(port, ip, async (error, address) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }
    console.log(`Server listening at ${address}\n`);
    console.log("Scan QR code with an LNURL-auth compatible wallet");
    const url = `${useHttps ? "https" : "http"}://${host}/lnurl-auth`;
    const lnurlAuthBech32 = createLnUrlAuth(k1, url);
    qrcode.generate(lnurlAuthBech32.toUpperCase(), { small: true });
    console.log(lnurlAuthBech32);
  });
})();
