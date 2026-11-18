//go:build windows

package dispatcher

import (
	"path/filepath"

	"golang.org/x/sys/windows"
)

func volumeFree(path string) int64 {
	dir := filepath.VolumeName(path) + `\`
	p, e := windows.UTF16PtrFromString(dir)
	if e != nil {
		return 0
	}
	var free, total, totalFree uint64
	if windows.GetDiskFreeSpaceEx(p, &free, &total, &totalFree) != nil {
		return 0
	}
	return int64(free)
}
