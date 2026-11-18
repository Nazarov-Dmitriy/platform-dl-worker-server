//go:build !windows

package dispatcher

import (
	"path/filepath"

	"golang.org/x/sys/unix"
)

func volumeFree(path string) int64 {
	var st unix.Statfs_t
	if unix.Statfs(filepath.Dir(path), &st) != nil {
		return 0
	}
	return int64(st.Bavail) * int64(st.Bsize)
}
