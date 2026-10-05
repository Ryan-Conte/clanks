CREATE TABLE `checkpoint` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`commit` text NOT NULL,
	`author` text NOT NULL,
	`label` text NOT NULL,
	`message_id` text,
	`tool_call_id` text,
	`after_message_id` text,
	`files` text NOT NULL,
	`head` text,
	`rewound` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkpoint_run_seq` ON `checkpoint` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`input` text,
	`output` text,
	`status` text,
	`tool_call_id` text,
	`checkpoint_id` text,
	`session_id` text,
	`started_at` integer NOT NULL,
	`duration_ms` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_conversation` ON `event` (`conversation_id`,`id`);--> statement-breakpoint
CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`transport` text NOT NULL,
	`command` text NOT NULL,
	`args` text NOT NULL,
	`url` text NOT NULL,
	`secret_names` text NOT NULL,
	`clanks` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_slug_unique` ON `mcp_server` (`slug`);--> statement-breakpoint
CREATE TABLE `review_note` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`start_line` integer,
	`end_line` integer,
	`body` text NOT NULL,
	`excerpt` text NOT NULL,
	`checkpoint_id` text,
	`status` text NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_note_run` ON `review_note` (`run_id`);--> statement-breakpoint
CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`clank_id` text NOT NULL,
	`folder` text NOT NULL,
	`repo_root` text NOT NULL,
	`worktree` text NOT NULL,
	`branch` text NOT NULL,
	`base_commit` text NOT NULL,
	`checkpoints_dir` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_conversation_id_unique` ON `run` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `tool_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`tool` text NOT NULL,
	`pattern` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_rule_scope_tool_pattern` ON `tool_rule` (`scope`,`tool`,`pattern`);--> statement-breakpoint
ALTER TABLE `clank` ADD `tools` text;--> statement-breakpoint
ALTER TABLE `message` ADD `parts` text;