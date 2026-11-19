// MOICA's issuer keys (spec/issuers.md), written into the Worker. Which
// issuer keys the back end accepts is not a setting (ADR-0028): the only
// other table is the test build's (test-build/target.ts), which is never
// deployed. test/issuers.test.ts checks these against
// spec/vectors/issuers.json.

export type IssuerName = "G2" | "G3";

export interface IssuerKey {
  readonly name: IssuerName;
  /** The RSA modulus, lowercase hex without a prefix; the exponent is 65537. */
  readonly modulus: string;
  readonly bits: 2048 | 4096;
}

export const MOICA_ISSUERS: readonly IssuerKey[] = Object.freeze([
  Object.freeze({
    name: "G2",
    bits: 2048,
    modulus:
      "9fd8089c05559d63d5ab34bc5df685fb5d2f44ba37ba5640238b00631ace7050" +
      "933509d0f9b6736ffea2a96820e1fbc0c5b21b3197e16d0d357a286395e75e64" +
      "402f37ae8fffcee2481c22a6558449e1352eb284424a2de2273617f60a5d4f7f" +
      "bb6564f1e93aa50ce8c4d30d83904009362a0160b5dd53e818f88f344af12e98" +
      "63e55268a4c81ba22094113875518cbf4d50195081d630aa402e2f9ea9384725" +
      "cfa8275423bb40bbd79cdd9d12371d0624b85a05f6f6223922c981551ea89e77" +
      "f04df3e22b93519fa37288717d2146b787b78703d5aa7ff1867f9c608f206e9c" +
      "6a39f00c2f2bfff9110a85bf15c25dae20b38a7f6f5a12026d08a1cbc681291d",
  }),
  Object.freeze({
    name: "G3",
    bits: 4096,
    modulus:
      "ae5ae964e29305a7dec0863d7f57aa664086045a7fbe0deccf420acae2e5f78e" +
      "9c0634893c7efadcd029b71e44272cd2b893c4324dfb527138ea36fc45b19737" +
      "2a60bada7430bbb798b25322784f32075254ce077a62fc1d9fb7b16429874c3a" +
      "8322f4b03eabadb16efafc367d1e13fde62c99039c2ec4eae6a3873bd90c998a" +
      "e4a6e32ccf9b94813ff1bf2af6a5fec7906d627e2f1b8745281327f424d69b81" +
      "464ab09093a15030834a798444866bd8b459789cd731e5e4b102968b79195283" +
      "9d23aae00024f6049069e57eb91260e1241df2b75ac943613e8ddbe78e8d468a" +
      "fa6565cf4587620ed34a752173a5264fa23d59f5793f5fd65ac06dffa53ca004" +
      "5a9f1ebe466760b0737f4bd5e302ad7332b2ff352e825d50d4649f9825642368" +
      "267e8c52135fe3cf048c2ec5483d8c897fb0600e384eaaaf61093d0cb68ca1d2" +
      "bb5f808b9beff43901e1ab38e8d9183c624a96f8466441d0f9d1d2f594f336b9" +
      "402a2f952ab5db34adfbe207e9dbf92bcfbac26e638830bfc5ab83d1ad43c14a" +
      "ef52e3d8bdd1acb8566b13da632becd0b752f2b82fc42d8ef46dd91da2954e16" +
      "ac5dcbbf7e6a60f1bda0f146875668051375ae31370162b52d4b6e813c688a9c" +
      "8ea2daa3819dd58f8caf6f8efc400f705643dbc10956653a7341d35bfff03a3f" +
      "f0af783895710202601d1810d967212d675c326f8e39157f5e1c6731c525d8ef",
  }),
] as const);

const SIZES: Readonly<Record<IssuerName, number>> = { G2: 2048, G3: 4096 };

/**
 * Throws unless the table is one G2 key of 2048 bits and one G3 key of 4096
 * bits, in that order. The Worker checks its table when it loads, so a build
 * with any other table does not start.
 */
export function checkIssuerTable(issuers: readonly IssuerKey[]): void {
  if (issuers.length !== 2 || issuers[0]!.name !== "G2" || issuers[1]!.name !== "G3") throw new Error("the issuer keys are not G2 and G3");
  for (const k of issuers) {
    const bits = SIZES[k.name];
    // The top bit is set when the first hex digit is 8 or more.
    if (k.bits !== bits || !new RegExp(`^[89a-f][0-9a-f]{${bits / 4 - 1}}$`).test(k.modulus)) throw new Error(`issuer ${k.name} is not a ${bits}-bit modulus`);
  }
}
