CREATE TABLE `routine` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`definition` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`conversation_id` text,
	`paused_reason` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`template` text,
	`replaces` text,
	`next_run_at` integer,
	`last_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routine_project` ON `routine` (`project_id`);--> statement-breakpoint
CREATE TABLE `routine_run` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`project_id` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`trigger` text NOT NULL,
	`inputs` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`asks` integer DEFAULT false NOT NULL,
	`ticket_ids` text NOT NULL,
	`notified` integer DEFAULT false NOT NULL,
	`reminded` integer DEFAULT false NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`routine_id`) REFERENCES `routine`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `routine_run_routine` ON `routine_run` (`routine_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `routine_run_project` ON `routine_run` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `scheduled_action` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text,
	`ticket_id` text,
	`step_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`connection_id` text,
	`payload` text,
	`media` text NOT NULL,
	`payload_hash` text,
	`execute_at` integer NOT NULL,
	`grace_ms` integer NOT NULL,
	`delivery` text NOT NULL,
	`status` text NOT NULL,
	`approved_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`attempt_id` text,
	`retry_at` integer,
	`result` text,
	`error` text,
	`made_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `routine_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduled_action_due` ON `scheduled_action` (`status`,`execute_at`);--> statement-breakpoint
CREATE INDEX `scheduled_action_run` ON `scheduled_action` (`run_id`);--> statement-breakpoint
ALTER TABLE `ticket` ADD `routine` text;