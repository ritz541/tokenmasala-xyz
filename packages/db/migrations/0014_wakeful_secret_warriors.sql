CREATE TABLE `usage_github_days` (
	`device_id` text NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`push_count` integer DEFAULT 0 NOT NULL,
	`commit_count` integer DEFAULT 0 NOT NULL,
	`pr_count` integer DEFAULT 0 NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `date`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_github_days_user_idx` ON `usage_github_days` (`user_id`);