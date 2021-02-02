import config from "config";
if (config.util.getConfigSources().length === 0) {
  throw new Error("Could not find any config sources. Did you forget to create the config file?");
}

import app from "./app";

const host = config.get<string>("serverHost");
const domain = host.split(":")[0];
const port = Number.parseInt(host.split(":")[1] ?? "8080");

const server = app();

server.listen(port, domain, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});
