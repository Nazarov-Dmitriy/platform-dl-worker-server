package dispatcher

import "testing"

func TestDeviceConfigurationDoesNotRequireWorkDirectory(t *testing.T) {
	s, _, _ := openTest(t)
	p, _ := testDevice(t, s)
	settings := map[string]any{"paused": false, "autostart": false, "maxParallel": 2,
		"cpuThresholdPercent": 70, "memoryThresholdPercent": 60, "diskThresholdPercent": 80}
	cmd := map[string]any{"requestId": UUID(), "type": "CONFIGURE", "settings": settings}
	if _, err := s.EnqueueCommand(testContext, p.ID, encode(cmd)); err != nil {
		t.Fatalf("configuration without a filesystem path: %v", err)
	}
	view, err := s.DeviceSettings(testContext, p.ID)
	if err != nil || view["desired"] == nil {
		t.Fatalf("settings were not saved: %v", err)
	}
	if _, exists := view["desired"].(map[string]any)["workDirectory"]; exists {
		t.Fatal("remote configuration unexpectedly contains workDirectory")
	}
}
