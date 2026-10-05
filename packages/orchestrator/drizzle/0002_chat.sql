CREATE TABLE `clank` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`avatar` text,
	`provider` text,
	`model` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`clank_id` text NOT NULL,
	`title` text NOT NULL,
	`folder` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_updated_at` ON `conversation` (`updated_at`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`reasoning` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`provider` text,
	`model` text,
	`usage` text,
	`finish_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_conversation_position` ON `message` (`conversation_id`,`position`);--> statement-breakpoint
CREATE TABLE `provider` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`secret_ref` text,
	`created_at` integer NOT NULL
);
