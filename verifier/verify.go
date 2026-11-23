package verifier

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// BBVersion is the version of bb the verifier runs (spec/proof-verification.md).
const BBVersion = "6.0.0"

// CRSFile is the one file of Barretenberg's common reference string that
// `bb verify` reads: the first point of BN254 G1, 64 bytes.
const (
	CRSFile       = "bn254_g1.dat"
	CRSFileSHA256 = "d6ba9329f8932c12192b37849f772104d20048f76434a3290512d9d814e4116f"
)

// DefaultTimeout is how long one `bb verify` may run before it counts as a
// rejection. A proof verifies in well under a second.
const DefaultTimeout = 30 * time.Second

// Config says where bb and the CRS are.
type Config struct {
	BB      string        // path of the bb 6.0.0 executable
	CRSDir  string        // directory holding CRSFile
	Timeout time.Duration // per proof; DefaultTimeout if zero
}

// Verifier verifies records (spec/record.md, "Verifying a record") by running
// `bb verify` as a child process.
type Verifier struct {
	cfg     Config
	issuers map[string]*big.Int // issuer name -> modulus
	crs     []byte
}

// Rejection is the error of a record that does not verify: the reason code
// `proof` of the record rules. Every other error from VerifyRecord means the
// verifier itself could not run and says nothing about the record.
type Rejection struct{ Reason string }

func (e *Rejection) Error() string { return "proof: " + e.Reason }

func reject(format string, args ...any) error {
	return &Rejection{Reason: fmt.Sprintf(format, args...)}
}

// New returns a verifier using the issuer keys compiled into the program. It
// checks that cfg.BB runs and is version 6.0.0, and that the CRS file has its
// SHA-256.
func New(cfg Config) (*Verifier, error) {
	return newVerifier(cfg, productionModuli())
}

func newVerifier(cfg Config, issuers map[string]*big.Int) (*Verifier, error) {
	if cfg.Timeout == 0 {
		cfg.Timeout = DefaultTimeout
	}
	v := &Verifier{cfg: cfg, issuers: issuers}
	if err := v.checkBB(); err != nil {
		return nil, err
	}
	crs, err := readCRS(cfg.CRSDir)
	if err != nil {
		return nil, err
	}
	v.crs = crs
	return v, nil
}

func (v *Verifier) checkBB() error {
	ctx, cancel := context.WithTimeout(context.Background(), v.cfg.Timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, v.cfg.BB, "--version").Output()
	if err != nil {
		return fmt.Errorf("running %s --version: %w", v.cfg.BB, err)
	}
	if got := strings.TrimSpace(string(out)); got != BBVersion {
		return fmt.Errorf("bb is version %q, not %s", got, BBVersion)
	}
	return nil
}

// readCRS reads the CRS file and checks its SHA-256.
func readCRS(dir string) ([]byte, error) {
	b, err := os.ReadFile(filepath.Join(dir, CRSFile))
	if err != nil {
		return nil, fmt.Errorf("CRS: %w", err)
	}
	if sum := sha256.Sum256(b); hex.EncodeToString(sum[:]) != CRSFileSHA256 {
		return nil, fmt.Errorf("CRS: %s does not have SHA-256 %s", CRSFile, CRSFileSHA256)
	}
	return b, nil
}

// PublicInputs rebuilds the public inputs of r's proof from r's fields and
// the tables compiled into the program, in the circuit's order
// (spec/record.md, step 2; spec/proof-verification.md, "Public inputs"). It
// also returns the circuit whose verification key has SHA-256 r.Circuit,
// after checking that it is accepted and goes with r.Issuer (step 1). An
// error is a Rejection.
func PublicInputs(r *Record) (Circuit, []Field, error) {
	return publicInputs(r, productionModuli())
}

// PublicInputs is the function PublicInputs with the verifier's issuer table.
func (v *Verifier) PublicInputs(r *Record) (Circuit, []Field, error) {
	return publicInputs(r, v.issuers)
}

func productionModuli() map[string]*big.Int {
	m := map[string]*big.Int{}
	for _, is := range productionIssuers {
		m[is.Name] = is.Modulus
	}
	return m
}

func publicInputs(r *Record, issuers map[string]*big.Int) (Circuit, []Field, error) {
	c, ok := LookupCircuit(r.Circuit)
	if !ok {
		return c, nil, reject("circuit %s is not accepted", r.Circuit)
	}
	if c.Issuer != r.Issuer {
		return c, nil, reject("circuit %s is not the circuit of issuer %s", c.Name, r.Issuer)
	}
	modulus, ok := issuers[r.Issuer]
	if !ok {
		return c, nil, reject("unknown issuer %s", r.Issuer)
	}
	limbs, err := ModulusLimbs(modulus, c.Limbs)
	if err != nil {
		return c, nil, reject("issuer %s: %v", r.Issuer, err)
	}
	root, err := ParseFieldHex(r.SMTRoot)
	if err != nil {
		return c, nil, reject("smt_root: %v", err)
	}
	date, err := ParseChallenge(r.Challenge)
	if err != nil {
		return c, nil, reject("%v", err)
	}
	nullifier, err := ParseScopedID(r.ScopedID)
	if err != nil {
		return c, nil, reject("%v", err)
	}
	scope, err := ScopePacked(r.ScopeString)
	if err != nil {
		return c, nil, reject("%v", err)
	}
	code := DeclarationCodePacked(DeclarationCode(r.ScopeString, r.Accounts, r.Challenge))
	inputs := append(limbs, root, currentTimeField(date), nullifier, scope, code)
	return c, inputs, nil
}

// EncodePublicInputs writes public inputs the way bb reads them: each a
// 32-byte big-endian integer, concatenated.
func EncodePublicInputs(inputs []Field) []byte {
	out := make([]byte, 0, 32*len(inputs))
	for _, f := range inputs {
		out = append(out, f[:]...)
	}
	return out
}

// VerifyRecord verifies a record whose line is well formed: steps 1 to 3 of
// spec/record.md, "Verifying a record", with the checks of
// spec/proof-verification.md around `bb verify`. It returns nil if the record
// verifies, a *Rejection if it does not, and any other error if the verifier
// could not run.
func (v *Verifier) VerifyRecord(r *Record) error {
	c, inputs, err := v.PublicInputs(r)
	if err != nil {
		return err
	}
	proof, err := r.ProofBytes()
	if err != nil {
		return reject("%v", err)
	}
	return v.VerifyProof(c, proof, inputs)
}

// VerifyProof runs `bb verify` on proof with public inputs under circuit c,
// after the checks bb must not be relied on for: the proof is exactly
// ProofLength bytes, there are exactly as many inputs as the circuit has, and
// each is below p. Any outcome of bb other than success is a rejection.
func (v *Verifier) VerifyProof(c Circuit, proof []byte, inputs []Field) error {
	if len(proof) != ProofLength {
		return reject("proof of %d bytes, not %d", len(proof), ProofLength)
	}
	if len(inputs) != c.PublicInputCount() {
		return reject("%d public inputs, not %d", len(inputs), c.PublicInputCount())
	}
	for i, f := range inputs {
		if err := CheckField(f); err != nil {
			return reject("public input %d: %v", i, err)
		}
	}
	return v.runBB(c.vk, proof, EncodePublicInputs(inputs))
}

// runBB writes the files bb reads into a fresh directory and runs
// `bb verify -t noir-recursive` on them. The CRS file is the copy checked in
// New, so bb never reads or downloads anything else.
func (v *Verifier) runBB(vk, proof, publicInputs []byte) error {
	dir, err := os.MkdirTemp("", "iamreal-verify-")
	if err != nil {
		return fmt.Errorf("temporary directory: %w", err)
	}
	defer os.RemoveAll(dir)
	crsDir := filepath.Join(dir, "crs")
	if err := os.Mkdir(crsDir, 0o700); err != nil {
		return err
	}
	files := map[string][]byte{
		filepath.Join(dir, "vk"):            vk,
		filepath.Join(dir, "proof"):         proof,
		filepath.Join(dir, "public_inputs"): publicInputs,
		filepath.Join(crsDir, CRSFile):      v.crs,
	}
	for name, b := range files {
		if err := os.WriteFile(name, b, 0o600); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), v.cfg.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, v.cfg.BB, "verify",
		"-k", filepath.Join(dir, "vk"),
		"-p", filepath.Join(dir, "proof"),
		"-i", filepath.Join(dir, "public_inputs"),
		"-c", crsDir,
		"-t", "noir-recursive")
	cmd.Dir = dir
	var output bytes.Buffer
	cmd.Stdout = &limitedWriter{w: &output, n: 4096}
	cmd.Stderr = cmd.Stdout
	cmd.WaitDelay = time.Second
	err = cmd.Run()
	switch {
	case ctx.Err() != nil:
		return reject("bb verify did not finish within %v", v.cfg.Timeout)
	case err != nil:
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return reject("bb verify failed (%v): %s", exit.ProcessState, lastLine(output.String()))
		}
		return fmt.Errorf("running bb: %w", err)
	}
	return nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

// limitedWriter keeps the first n bytes and drops the rest.
type limitedWriter struct {
	w *bytes.Buffer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if room := l.n - l.w.Len(); room > 0 {
		if len(p) > room {
			l.w.Write(p[:room])
		} else {
			l.w.Write(p)
		}
	}
	return len(p), nil
}
