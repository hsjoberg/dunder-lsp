import fs from "fs";
import { Client, loadPackageDefinition, credentials, Metadata } from "@grpc/grpc-js";
import os from "os";
import * as protoLoader from "@grpc/proto-loader";
import { GrpcObject } from "@grpc/grpc-js/build/src/make-client";
import config from "config";

export const rpcImpl = (rpc: string, client: Client) => {
  return (method: any, requestData: any, callback: any) => {
    client.makeUnaryRequest(
      rpc + "/" + method.name,
      (arg: any) => arg,
      (arg: any) => arg,
      requestData,
      callback,
    );
  };
};

/**
 * Keepalive pings on the connection to lnd. Without them a connection that dies
 * silently (lnd host loses power, a NAT or firewall drops it) never produces an
 * error, so the HTLC interceptor and event streams would look connected while
 * receiving nothing, and would never reconnect. With pings, a missing reply
 * closes the connection and every open stream errors and reconnects.
 *
 * lnd rejects clients that ping more often than `grpc.client-ping-min-wait`
 * (default 5s) and, by default, pings sent while no call is open.
 */
export const GRPC_CHANNEL_OPTIONS = {
  "grpc.keepalive_time_ms": 60_000,
  "grpc.keepalive_timeout_ms": 20_000,
  "grpc.keepalive_permit_without_calls": 0,
};

export const getGrpcClients = () => {
  const loaderOptions = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  };
  const grpcServer = config.get<string>("backendConfig.grpcServer");
  const tlsCert = config.get<string>("backendConfig.cert").replace("~", os.homedir);
  const adminMacaroon = config.get<string>("backendConfig.adminMacaroon").replace("~", os.homedir);

  const packageDefinition = protoLoader.loadSync(
    ["./proto/rpc.proto", "./proto/router.proto"],
    loaderOptions,
  );
  const lnrpcProto = loadPackageDefinition(packageDefinition).lnrpc as GrpcObject;
  const routerProto = loadPackageDefinition(packageDefinition).routerrpc as GrpcObject;
  const macaroon = fs.readFileSync(adminMacaroon).toString("hex");
  process.env.GRPC_SSL_CIPHER_SUITES = "HIGH+ECDSA";
  const lndCert = fs.readFileSync(tlsCert);
  const sslCreds = credentials.createSsl(lndCert);
  let metadata = new Metadata();
  metadata.add("macaroon", macaroon);
  const macaroonCreds = credentials.createFromMetadataGenerator((args: any, callback: any) => {
    callback(null, metadata);
  });
  let callCreds = credentials.combineCallCredentials(macaroonCreds);
  let creds = credentials.combineChannelCredentials(sslCreds, macaroonCreds);

  let lightning = new (lnrpcProto as any).Lightning(
    grpcServer,
    creds,
    GRPC_CHANNEL_OPTIONS,
  ) as Client;
  let router = new (routerProto as any).Router(grpcServer, creds, GRPC_CHANNEL_OPTIONS) as Client;

  return { lightning, router };
};

export const grpcReqSerialize = (args: any) => args;

export const grpcReqDeserialize = (args: any) => args;

export const grpcMakeUnaryRequest = <Response = unknown>(
  client: Client,
  method: string,
  argument: Uint8Array,
  decoder = (data: Uint8Array) => data as any,
): Promise<Response> => {
  return new Promise((resolve, reject) => {
    client.makeUnaryRequest(method, grpcReqSerialize, grpcReqDeserialize, argument, (err, res) => {
      if (err) {
        return reject(err);
      }
      resolve(decoder(res));
    });
  });
};
