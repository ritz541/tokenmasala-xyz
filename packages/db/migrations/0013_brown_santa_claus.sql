CREATE TABLE `usage_sessions` (
	`device_id` text NOT NULL,
	`source` text NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`last_activity` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `source`, `session_id`)
);
--> statement-breakpoint
CREATE INDEX `usage_sessions_user_idx` ON `usage_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `usage_sessions_device_date_idx` ON `usage_sessions` (`device_id`,`date`);