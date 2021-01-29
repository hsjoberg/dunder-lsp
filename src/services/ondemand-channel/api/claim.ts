import { Client } from "@grpc/grpc-js";
import { RouteHandlerMethod } from "fastify";

export interface IClaimRequest {}

export interface IClaimResponse {}

export default function Claim(lightning: Client): RouteHandlerMethod {
  return async (request, reply) => {
    reply.code(400);
    return { status: "ERROR", reason: "Not implemeneted." };
  };
}
