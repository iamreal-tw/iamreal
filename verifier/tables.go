package verifier

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"math/big"
)

// Issuer is one of MOICA's issuer keys (spec/issuers.md, "The keys").
type Issuer struct {
	Name string // the record's `issuer` field
	// CertificateSHA256 is the SHA-256 of the issuer certificate (DER), as
	// spec/issuers.md lists it. It documents where Modulus comes from; the
	// verifier does not read the certificate.
	CertificateSHA256 string
	ModulusBits       int
	Modulus           *big.Int
}

// Circuit is one row of the accepted circuits (spec/record.md, "Accepted
// circuits"; spec/proof-verification.md, "Circuits and proving system").
type Circuit struct {
	Name     string
	Issuer   string // the only issuer whose records use this circuit
	Limbs    int    // K, the number of 120-bit limbs of issuer_modulus
	VKSHA256 string // the record's `circuit` field
	vk       []byte
}

// PublicInputCount returns the number of public inputs of the circuit: K + 5.
func (c Circuit) PublicInputCount() int { return c.Limbs + 5 }

// VerificationKey returns a copy of the circuit's verification key.
func (c Circuit) VerificationKey() []byte { return append([]byte(nil), c.vk...) }

func mustModulus(hexDigits string) *big.Int {
	m, ok := new(big.Int).SetString(hexDigits, 16)
	if !ok {
		panic("bad modulus")
	}
	return m
}

// productionIssuers is the table of spec/issuers.md. Keys used in tests never
// appear here, and no setting adds one: tests replace the table through
// export_test.go, which is compiled only into tests.
var productionIssuers = []Issuer{
	{
		Name:              "G2",
		CertificateSHA256: "c4c462de463f856804dc898338d2cecb55fba74155851599d8fb7d70218fd1be",
		ModulusBits:       2048,
		Modulus: mustModulus("" +
			"9fd8089c05559d63d5ab34bc5df685fb5d2f44ba37ba5640238b00631ace7050" +
			"933509d0f9b6736ffea2a96820e1fbc0c5b21b3197e16d0d357a286395e75e64" +
			"402f37ae8fffcee2481c22a6558449e1352eb284424a2de2273617f60a5d4f7f" +
			"bb6564f1e93aa50ce8c4d30d83904009362a0160b5dd53e818f88f344af12e98" +
			"63e55268a4c81ba22094113875518cbf4d50195081d630aa402e2f9ea9384725" +
			"cfa8275423bb40bbd79cdd9d12371d0624b85a05f6f6223922c981551ea89e77" +
			"f04df3e22b93519fa37288717d2146b787b78703d5aa7ff1867f9c608f206e9c" +
			"6a39f00c2f2bfff9110a85bf15c25dae20b38a7f6f5a12026d08a1cbc681291d"),
	},
	{
		Name:              "G3",
		CertificateSHA256: "ed793fd0d50a2a398049d598982cf01e75f873b532066caec238f800a06ca9da",
		ModulusBits:       4096,
		Modulus: mustModulus("" +
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
			"f0af783895710202601d1810d967212d675c326f8e39157f5e1c6731c525d8ef"),
	},
}

//go:embed vk/card_proof_rs2048.vk vk/card_proof_rs4096.vk
var vkFiles embed.FS

// acceptedCircuits is the table of spec/record.md. When a circuit changes, a
// row is added; old rows stay.
var acceptedCircuits = []Circuit{
	{Name: "card_proof_rs2048", Issuer: "G2", Limbs: 18, VKSHA256: "816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8"},
	{Name: "card_proof_rs4096", Issuer: "G3", Limbs: 35, VKSHA256: "bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2"},
}

func init() {
	for i := range acceptedCircuits {
		c := &acceptedCircuits[i]
		vk, err := vkFiles.ReadFile("vk/" + c.Name + ".vk")
		if err != nil {
			panic(err)
		}
		if sum := sha256.Sum256(vk); hex.EncodeToString(sum[:]) != c.VKSHA256 {
			panic(fmt.Sprintf("verification key of %s does not match its SHA-256", c.Name))
		}
		c.vk = vk
	}
	for _, is := range productionIssuers {
		if is.Modulus.BitLen() != is.ModulusBits {
			panic("issuer " + is.Name + ": modulus size")
		}
	}
}

// Issuers returns the issuer table compiled into the program.
func Issuers() []Issuer {
	out := make([]Issuer, len(productionIssuers))
	for i, is := range productionIssuers {
		is.Modulus = new(big.Int).Set(is.Modulus)
		out[i] = is
	}
	return out
}

// AcceptedCircuits returns the accepted circuits compiled into the program.
func AcceptedCircuits() []Circuit { return append([]Circuit(nil), acceptedCircuits...) }

// LookupCircuit returns the accepted circuit whose verification key has the
// SHA-256 vkSHA256.
func LookupCircuit(vkSHA256 string) (Circuit, bool) {
	for _, c := range acceptedCircuits {
		if c.VKSHA256 == vkSHA256 {
			return c, true
		}
	}
	return Circuit{}, false
}

// ModulusLimbs splits a modulus into k limbs of 120 bits, least significant
// first: the public input issuer_modulus.
func ModulusLimbs(m *big.Int, k int) ([]Field, error) {
	if m.Sign() <= 0 || m.BitLen() > 120*k {
		return nil, fmt.Errorf("modulus does not fit %d limbs of 120 bits", k)
	}
	mask := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 120), big.NewInt(1))
	out := make([]Field, k)
	for i := range out {
		limb := new(big.Int).And(new(big.Int).Rsh(m, uint(120*i)), mask)
		out[i], _ = FieldFromBigInt(limb)
	}
	return out, nil
}
