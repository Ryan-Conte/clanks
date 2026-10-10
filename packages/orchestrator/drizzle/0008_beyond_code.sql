CREATE TABLE `artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`ticket_id` text,
	`conversation_id` text,
	`author` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifact_ticket` ON `artifact` (`ticket_id`,`name`,`version`);--> statement-breakpoint
CREATE INDEX `artifact_conversation` ON `artifact` (`conversation_id`);--> statement-breakpoint
ALTER TABLE `ticket` ADD `sent` text;