CREATE TABLE `connection` (
	`id` text PRIMARY KEY NOT NULL,
	`integration` text NOT NULL,
	`label` text NOT NULL,
	`auth_type` text NOT NULL,
	`mode` text NOT NULL,
	`account` text,
	`settings` text NOT NULL,
	`hosts` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer,
	`connected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connection_integration` ON `connection` (`integration`);--> statement-breakpoint
CREATE TABLE `package` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`package_id` text NOT NULL,
	`name` text NOT NULL,
	`index_url` text NOT NULL,
	`version` text NOT NULL,
	`sha256` text NOT NULL,
	`publisher` text NOT NULL,
	`licence` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`latest` text,
	`notice` text,
	`data` text,
	`installed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_integration` (
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`clanks` text NOT NULL,
	PRIMARY KEY(`project_id`, `connection_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `mcp_server` ADD `integration` text;--> statement-breakpoint
ALTER TABLE `mcp_server` ADD `docker` integer DEFAULT false NOT NULL;