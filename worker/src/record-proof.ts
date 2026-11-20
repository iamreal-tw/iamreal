// Verifying a record (spec/record.md, "Verifying a record"): the circuit
// its `circuit` and `issuer` name, and every public input rebuilt from the
// record's own fields (spec/proof-verification.md, "Public inputs"). None is
// taken from anything that came with the proof. The proof itself is then
// the proof verifier's (src/verify.ts).
import { asciiBytes, limbs } from "iamreal-protocol/bytes.ts";
import { currentTime, parseChallenge } from "iamreal-protocol/challenge.ts";
import { declarationCode } from "iamreal-protocol/declaration-code.ts";
import { fieldBytes, pack31 } from "iamreal-protocol/field.ts";
import { type RecordFields, decodeProof } from "iamreal-protocol/record.ts";
import { parseScopedId } from "iamreal-protocol/scoped-id.ts";
import { CIRCUITS, CIRCUIT_NAMES, type CircuitName } from "./circuits.ts";
import type { IssuerKey } from "./issuers.ts";
import type { ProofVerifier } from "./verify.ts";

/** The public inputs of a circuit after the limbs of the issuer key's modulus: `smt_root`, `current_time`, `nullifier`, `scope_packed`, `declaration_code_packed`. */
const INPUTS_AFTER_MODULUS = 5;

/**
 * The circuit of a record and its public inputs, in the circuit's order,
 * each 32 bytes big-endian; or null if the record names no accepted circuit,
 * a circuit that is not its issuer's, or an issuer the build has no key for.
 * `fields` are in their formats (protocol/, fieldsProblem); `issuers` are
 * the issuer keys of the build.
 */
export async function publicInputsOf(fields: RecordFields, issuers: readonly IssuerKey[]): Promise<{ circuit: CircuitName; inputs: Uint8Array[] } | null> {
  const circuit = CIRCUIT_NAMES.find((name) => CIRCUITS[name].verificationKeySha256 === fields.circuit);
  if (circuit === undefined || CIRCUITS[circuit].issuer !== fields.issuer) return null;
  const key = issuers.find((k) => k.name === fields.issuer);
  if (key === undefined) return null;
  const date = parseChallenge(fields.challenge);
  const nullifier = parseScopedId(fields.scopedId);
  if (date === null || nullifier === null) throw new Error("the record's fields are not in their formats");
  const inputs = [
    ...limbs(BigInt(`0x${key.modulus}`), 120, CIRCUITS[circuit].publicInputCount - INPUTS_AFTER_MODULUS),
    BigInt(`0x${fields.smtRoot}`),
    currentTime(date),
    nullifier,
    pack31(asciiBytes(fields.scopeString)),
    // From the record's whole list and its challenge: neither is a public input of its own.
    pack31(await declarationCode(fields.scopeString, fields.accounts, fields.challenge)),
  ];
  return { circuit, inputs: inputs.map(fieldBytes) };
}

/**
 * Whether the record verifies: check 1 of the roster rules. False for a
 * record whose circuit is not accepted or not its issuer's, and for a proof
 * the verifier does not accept. Rejects when the verifier itself could not
 * run (src/verify.ts): that is no verdict, and the record must not be
 * written.
 */
export async function recordVerifies(fields: RecordFields, issuers: readonly IssuerKey[], verifier: ProofVerifier): Promise<boolean> {
  const statement = await publicInputsOf(fields, issuers);
  const proof = decodeProof(fields.proof);
  if (statement === null || proof === null) return false;
  return verifier.verify(statement.circuit, proof, statement.inputs);
}
