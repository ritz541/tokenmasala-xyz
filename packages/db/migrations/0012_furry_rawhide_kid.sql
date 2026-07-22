CREATE TABLE `device_watermarks` (
	`device_id` text NOT NULL,
	`source` text NOT NULL,
	`last_event_ts` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `source`)
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`user_id` text NOT NULL,
	`ts` integer NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_events_user_ts_idx` ON `usage_events` (`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `usage_events_device_ts_idx` ON `usage_events` (`device_id`,`ts`);--> statement-breakpoint
CREATE INDEX `usage_events_device_date_idx` ON `usage_events` (`device_id`,`date`);