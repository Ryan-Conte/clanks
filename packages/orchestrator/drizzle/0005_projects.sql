CREATE TABLE `board_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`ticket_id` text,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `board_event_project` ON `board_event` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `bounce` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`reason` text NOT NULL,
	`issues` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bounce_ticket` ON `bounce` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`brief` text NOT NULL,
	`key` text NOT NULL,
	`folder` text NOT NULL,
	`repo` text,
	`provider` text,
	`model` text,
	`next_number` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_clank` (
	`project_id` text NOT NULL,
	`clank_id` text NOT NULL,
	`provider` text,
	`model` text,
	PRIMARY KEY(`project_id`, `clank_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `spec` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`ticket_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`approved_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_project_version` ON `spec` (`project_id`,`version`);--> statement-breakpoint
CREATE TABLE `ticket` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`number` integer NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`type` text NOT NULL,
	`stories` text NOT NULL,
	`criteria` text NOT NULL,
	`assignee` text,
	`route` text NOT NULL,
	`step` integer NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`bounces` integer DEFAULT 0 NOT NULL,
	`rank` real NOT NULL,
	`origin` text NOT NULL,
	`created_by` text NOT NULL,
	`proposed` integer DEFAULT false NOT NULL,
	`spec_version` integer,
	`progress` text,
	`output` text,
	`reviews` text NOT NULL,
	`conversation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`done_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_project_number` ON `ticket` (`project_id`,`number`);--> statement-breakpoint
CREATE TABLE `ticket_dependency` (
	`ticket_id` text NOT NULL,
	`depends_on` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `depends_on`),
	FOREIGN KEY (`ticket_id`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on`) REFERENCES `ticket`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `conversation` ADD `project_id` text REFERENCES project(id) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `conversation` ADD `ticket_id` text REFERENCES ticket(id) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `conversation` ADD `role` text;--> statement-breakpoint
CREATE INDEX `conversation_ticket` ON `conversation` (`ticket_id`);--> statement-breakpoint
ALTER TABLE `message` ADD `author` text;