package crl

// CRL patches (spec/revocation-tree.md, "CRL patches"): a file that gives a
// usable CRL of the archive from the previous one of the same issuer key.
// Only two instructions: copy a part of the previous file, and write the
// bytes that follow. A patch is a shortcut for downloading, not part of the
// archive: what it gives counts only if it has the SHA-256 of the file it
// stands for (RestorePatch), so a reader need not trust it.

import (
	"encoding/binary"
	"fmt"
)

// The instructions' first bytes.
const (
	patchCopy  = 0x00
	patchWrite = 0x01
)

// PatchesDir is the subdirectory of an archive's directory that holds its
// patches. It is not part of the archive (spec/revocation-tree.md, "Files").
const PatchesDir = "patches"

// UnusablePatch is why a patch cannot be used; any one makes the whole
// patch unusable.
type UnusablePatch struct{ Reason string }

func (u *UnusablePatch) Error() string { return "unusable CRL patch: " + u.Reason }

func unusablePatch(format string, a ...any) error {
	return &UnusablePatch{fmt.Sprintf(format, a...)}
}

// PatchName is the name, in PatchesDir, of the patch from the file with
// SHA-256 from to the file with SHA-256 to (64 lowercase hex digits each).
func PatchName(from, to string) string { return from + "-" + to + ".patch" }

// ApplyPatch returns the file patch gives from previous, or an
// *UnusablePatch. Time and memory are in proportion to the two inputs: the
// copies go forward through previous and never overlap, so what they give
// is at most previous, and what the writes give is in patch. The patch is
// read twice: once to check it and count the bytes it gives, once to give
// them.
func ApplyPatch(previous, patch []byte) ([]byte, error) {
	n := 0
	if err := walkPatch(previous, patch, func(b []byte) { n += len(b) }); err != nil {
		return nil, err
	}
	out := make([]byte, 0, n)
	walkPatch(previous, patch, func(b []byte) { out = append(out, b...) })
	return out, nil
}

// RestorePatch is ApplyPatch, with the file's SHA-256 checked against
// want (the second half of the patch's name): a file without it is an
// *UnusablePatch too.
func RestorePatch(previous, patch []byte, want string) ([]byte, error) {
	file, err := ApplyPatch(previous, patch)
	if err != nil {
		return nil, err
	}
	if got := sha256Hex(file); got != want {
		return nil, unusablePatch("it gives a file with SHA-256 %s, not %s", got, want)
	}
	return file, nil
}

// walkPatch goes through the instructions, checking each, and hands give
// the bytes each gives. Numbers are 4 bytes, unsigned and big-endian; they
// are added as uint64, so that no sum wraps.
func walkPatch(previous, patch []byte, give func([]byte)) error {
	var copied uint64 // where the last copy ended: the next may not start before it
	size := uint64(len(patch))
	for at := uint64(0); at < size; {
		switch patch[at] {
		case patchCopy:
			if at+9 > size {
				return unusablePatch("a copy at byte %d runs past the end of the patch", at)
			}
			start := uint64(binary.BigEndian.Uint32(patch[at+1:]))
			n := uint64(binary.BigEndian.Uint32(patch[at+5:]))
			if start < copied {
				return unusablePatch("a copy at byte %d starts at %d, before the last copy ended at %d", at, start, copied)
			}
			if start+n > uint64(len(previous)) {
				return unusablePatch("a copy at byte %d ends at %d, past the previous file's %d bytes", at, start+n, len(previous))
			}
			give(previous[start : start+n])
			copied = start + n
			at += 9
		case patchWrite:
			if at+5 > size {
				return unusablePatch("a write at byte %d runs past the end of the patch", at)
			}
			n := uint64(binary.BigEndian.Uint32(patch[at+1:]))
			if at+5+n > size {
				return unusablePatch("a write at byte %d of %d bytes runs past the end of the patch", at, n)
			}
			give(patch[at+5 : at+5+n])
			at += 5 + n
		default:
			return unusablePatch("byte %d is %d, which is no instruction", at, patch[at])
		}
	}
	return nil
}
