CREATE TABLE `model` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`repo` text NOT NULL,
	`revision` text NOT NULL,
	`quant` text,
	`params` text,
	`license` text,
	`tags` text NOT NULL,
	`capabilities` text NOT NULL,
	`files` text NOT NULL,
	`facts` text NOT NULL,
	`size` integer NOT NULL,
	`keep_loaded` integer DEFAULT false NOT NULL,
	`pulled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_pull` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`state` text NOT NULL,
	`plan` text,
	`chunks` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_setting`("key", "value", "updated_at") SELECT "key", "value", "updated_at" FROM `setting`;--> statement-breakpoint
DROP TABLE `setting`;--> statement-breakpoint
ALTER TABLE `__new_setting` RENAME TO `setting`;--> statement-breakpoint
PRAGMA foreign_keys=ON;