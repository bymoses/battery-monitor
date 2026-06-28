ALTER TABLE environment_samples ADD COLUMN usb_power_source INTEGER;
ALTER TABLE environment_samples ADD COLUMN usb_power_w REAL;
ALTER TABLE environment_samples ADD COLUMN usb_power_detail TEXT NOT NULL DEFAULT '';
