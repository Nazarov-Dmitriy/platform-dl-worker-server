package dispatcher

import "testing"

func TestDeviceConfigurationDoesNotRequireWorkDirectory(t *testing.T) {
	s, _, _ := openTest(t)
	p, _ := testDevice(t, s)
	settings := map[string]any{"paused": false, "maxParallel": 2,
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

func TestDeviceConfigurationSchemaCompatibility(t *testing.T) {
	s, _, _ := openTest(t)
	settings := map[string]any{"paused": false, "maxParallel": 2,
		"cpuThresholdPercent": 70, "memoryThresholdPercent": 60, "diskThresholdPercent": 80}
	check := func(settings map[string]any) error {
		return s.validator.Check("AdminCommand", encode(map[string]any{
			"requestId": UUID(), "type": "CONFIGURE", "settings": settings,
		}))
	}
	// Older clients may still send either local setting; both remain optional.
	for _, extra := range []map[string]any{
		{}, {"workDirectory": "C:/worker"}, {"autostart": false},
		{"workDirectory": "C:/worker", "autostart": true},
	} {
		candidate := map[string]any{}
		for key, value := range settings {
			candidate[key] = value
		}
		for key, value := range extra {
			candidate[key] = value
		}
		if err := check(candidate); err != nil {
			t.Fatalf("legacy settings %v: %v", extra, err)
		}
	}
	for key := range settings {
		candidate := map[string]any{}
		for k, value := range settings {
			if k != key {
				candidate[k] = value
			}
		}
		if err := check(candidate); err == nil {
			t.Fatalf("accepted missing processing setting %s", key)
		}
	}
}
