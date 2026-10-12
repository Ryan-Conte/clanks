CREATE TABLE `context_note` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`why` text NOT NULL,
	`author` text NOT NULL,
	`ticket_id` text,
	`status` text NOT NULL,
	`supersedes` text,
	`pinned` integer DEFAULT false NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_note_project` ON `context_note` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `memory` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`clank_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`ticket_id` text,
	`conversation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_project_clank` ON `memory` (`project_id`,`clank_id`);--> statement-breakpoint
ALTER TABLE `project` ADD `base_branch` text;--> statement-breakpoint
ALTER TABLE `project` ADD `max_runs` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `bounce_limit` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `optional_checks` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `budget` text;--> statement-breakpoint
ALTER TABLE `project` ADD `clank_budgets` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `project` ADD `sandbox` text;--> statement-breakpoint
ALTER TABLE `project` ADD `held` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket` ADD `skipped` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket` ADD `detour` text;--> statement-breakpoint
ALTER TABLE `ticket` ADD `queued` text;--> statement-breakpoint
ALTER TABLE `ticket` ADD `delivery` text;--> statement-breakpoint
ALTER TABLE `ticket` ADD `outcome` text;--> statement-breakpoint
UPDATE `ticket` SET `outcome` = 'approved' WHERE `done_at` IS NOT NULL;--> statement-breakpoint
CREATE VIRTUAL TABLE `context_note_fts` USING fts5(`id` UNINDEXED, `title`, `body`, `why`, tokenize = 'porter unicode61');--> statement-breakpoint
CREATE TRIGGER `context_note_fts_insert` AFTER INSERT ON `context_note` BEGIN
	INSERT INTO `context_note_fts` (`id`, `title`, `body`, `why`) VALUES (new.`id`, new.`title`, new.`body`, new.`why`);
END;--> statement-breakpoint
CREATE TRIGGER `context_note_fts_update` AFTER UPDATE OF `title`, `body`, `why` ON `context_note` BEGIN
	DELETE FROM `context_note_fts` WHERE `id` = old.`id`;
	INSERT INTO `context_note_fts` (`id`, `title`, `body`, `why`) VALUES (new.`id`, new.`title`, new.`body`, new.`why`);
END;--> statement-breakpoint
CREATE TRIGGER `context_note_fts_delete` AFTER DELETE ON `context_note` BEGIN
	DELETE FROM `context_note_fts` WHERE `id` = old.`id`;
END;--> statement-breakpoint
CREATE VIRTUAL TABLE `memory_fts` USING fts5(`id` UNINDEXED, `body`, tokenize = 'porter unicode61');--> statement-breakpoint
CREATE TRIGGER `memory_fts_insert` AFTER INSERT ON `memory` BEGIN
	INSERT INTO `memory_fts` (`id`, `body`) VALUES (new.`id`, new.`body`);
END;--> statement-breakpoint
CREATE TRIGGER `memory_fts_update` AFTER UPDATE OF `body` ON `memory` BEGIN
	DELETE FROM `memory_fts` WHERE `id` = old.`id`;
	INSERT INTO `memory_fts` (`id`, `body`) VALUES (new.`id`, new.`body`);
END;--> statement-breakpoint
CREATE TRIGGER `memory_fts_delete` AFTER DELETE ON `memory` BEGIN
	DELETE FROM `memory_fts` WHERE `id` = old.`id`;
END;
