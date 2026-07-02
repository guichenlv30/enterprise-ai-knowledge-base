CREATE DATABASE IF NOT EXISTS `enterprise_ai_kb`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `enterprise_ai_kb`;

CREATE TABLE IF NOT EXISTS `aikb_meta` (
  `id` TINYINT PRIMARY KEY,
  `data_json` JSON NOT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_department` (
  `id` BIGINT PRIMARY KEY,
  `name` VARCHAR(128) NOT NULL,
  `parent_id` BIGINT,
  `created_at` VARCHAR(32) NOT NULL,
  `updated_at` VARCHAR(32) NOT NULL,
  INDEX `idx_department_parent` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_user` (
  `id` BIGINT PRIMARY KEY,
  `username` VARCHAR(64) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `nickname` VARCHAR(64) NOT NULL,
  `department_id` BIGINT,
  `role` VARCHAR(32) NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `created_at` VARCHAR(32) NOT NULL,
  `updated_at` VARCHAR(32) NOT NULL,
  INDEX `idx_user_department` (`department_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_knowledge_base` (
  `id` BIGINT PRIMARY KEY,
  `name` VARCHAR(128) NOT NULL,
  `description` VARCHAR(512),
  `owner_id` BIGINT NOT NULL,
  `department_id` BIGINT,
  `visibility` VARCHAR(32) NOT NULL,
  `tags_json` JSON NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `document_count` INT NOT NULL DEFAULT 0,
  `chunk_count` INT NOT NULL DEFAULT 0,
  `qa_count` INT NOT NULL DEFAULT 0,
  `created_at` VARCHAR(32) NOT NULL,
  `updated_at` VARCHAR(32) NOT NULL,
  INDEX `idx_kb_owner` (`owner_id`),
  INDEX `idx_kb_department` (`department_id`),
  INDEX `idx_kb_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_kb_member` (
  `id` BIGINT PRIMARY KEY,
  `kb_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `permission` VARCHAR(32) NOT NULL,
  `created_at` VARCHAR(32) NOT NULL,
  UNIQUE KEY `uniq_kb_member` (`kb_id`, `user_id`),
  INDEX `idx_member_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_document` (
  `id` BIGINT PRIMARY KEY,
  `kb_id` BIGINT NOT NULL,
  `title` VARCHAR(255),
  `file_name` VARCHAR(255) NOT NULL,
  `file_type` VARCHAR(32) NOT NULL,
  `file_size` BIGINT NOT NULL,
  `file_path` VARCHAR(512) NOT NULL,
  `tags_json` JSON NOT NULL,
  `parse_status` VARCHAR(32) NOT NULL,
  `error_message` TEXT,
  `created_by` BIGINT NOT NULL,
  `reference_count` INT NOT NULL DEFAULT 0,
  `created_at` VARCHAR(32) NOT NULL,
  `updated_at` VARCHAR(32) NOT NULL,
  INDEX `idx_document_kb` (`kb_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_document_chunk` (
  `id` BIGINT PRIMARY KEY,
  `document_id` BIGINT NOT NULL,
  `kb_id` BIGINT NOT NULL,
  `chunk_index` INT NOT NULL,
  `title` VARCHAR(255),
  `content` MEDIUMTEXT NOT NULL,
  `vector_id` VARCHAR(128) NOT NULL,
  `vector_json` JSON NOT NULL,
  `token_count` INT NOT NULL,
  `page_number` INT,
  `created_at` VARCHAR(32) NOT NULL,
  INDEX `idx_chunk_document` (`document_id`),
  INDEX `idx_chunk_kb` (`kb_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_chat_session` (
  `id` BIGINT PRIMARY KEY,
  `kb_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `archived_at` VARCHAR(32),
  `created_at` VARCHAR(32) NOT NULL,
  `updated_at` VARCHAR(32) NOT NULL,
  INDEX `idx_session_user` (`user_id`),
  INDEX `idx_session_kb` (`kb_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_chat_message` (
  `id` BIGINT PRIMARY KEY,
  `session_id` BIGINT NOT NULL,
  `role` VARCHAR(32) NOT NULL,
  `content` MEDIUMTEXT NOT NULL,
  `prompt_snapshot` MEDIUMTEXT,
  `llm_used` TINYINT,
  `llm_provider` VARCHAR(40),
  `llm_model` VARCHAR(80),
  `answer_source` VARCHAR(32),
  `retrieval_count` INT,
  `llm_error` TEXT,
  `llm_finish_reason` VARCHAR(64),
  `created_at` VARCHAR(32) NOT NULL,
  INDEX `idx_message_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_answer_reference` (
  `id` BIGINT PRIMARY KEY,
  `message_id` BIGINT NOT NULL,
  `chunk_id` BIGINT NOT NULL,
  `document_id` BIGINT NOT NULL,
  `score` DECIMAL(10, 8) NOT NULL,
  `created_at` VARCHAR(32) NOT NULL,
  INDEX `idx_reference_message` (`message_id`),
  INDEX `idx_reference_chunk` (`chunk_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_answer_feedback` (
  `id` BIGINT PRIMARY KEY,
  `message_id` BIGINT NOT NULL,
  `session_id` BIGINT NOT NULL,
  `kb_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `rating` VARCHAR(32) NOT NULL,
  `reason` VARCHAR(32) NOT NULL,
  `comment` TEXT,
  `created_at` VARCHAR(32) NOT NULL,
  UNIQUE KEY `uniq_feedback_message_user` (`message_id`, `user_id`),
  INDEX `idx_feedback_kb` (`kb_id`),
  INDEX `idx_feedback_rating` (`rating`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_prompt_template` (
  `id` BIGINT PRIMARY KEY,
  `name` VARCHAR(80) NOT NULL,
  `scene` VARCHAR(64) NOT NULL DEFAULT '知识库问答',
  `content` MEDIUMTEXT NOT NULL,
  `variables_json` JSON NOT NULL,
  `active` TINYINT NOT NULL DEFAULT 0,
  `status` TINYINT NOT NULL DEFAULT 1,
  `created_by` BIGINT,
  `created_at` VARCHAR(32) NOT NULL,
  `updated_at` VARCHAR(32) NOT NULL,
  INDEX `idx_prompt_status` (`status`),
  INDEX `idx_prompt_active` (`active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_workflow_definition` (
  `id` BIGINT PRIMARY KEY,
  `name` VARCHAR(128) NOT NULL,
  `scene` VARCHAR(64) NOT NULL,
  `description` VARCHAR(512),
  `config_json` JSON NOT NULL,
  `status` TINYINT NOT NULL DEFAULT 1,
  `created_at` VARCHAR(32) NOT NULL,
  `updated_at` VARCHAR(32) NOT NULL,
  INDEX `idx_workflow_status` (`status`),
  INDEX `idx_workflow_scene` (`scene`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_workflow_run` (
  `id` BIGINT PRIMARY KEY,
  `workflow_id` BIGINT NOT NULL,
  `user_id` BIGINT NOT NULL,
  `kb_id` BIGINT,
  `input_json` JSON NOT NULL,
  `output_text` MEDIUMTEXT,
  `status` VARCHAR(32) NOT NULL,
  `error_message` TEXT,
  `created_at` VARCHAR(32) NOT NULL,
  `finished_at` VARCHAR(32),
  INDEX `idx_workflow_run_user` (`user_id`),
  INDEX `idx_workflow_run_workflow` (`workflow_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_model_config` (
  `id` TINYINT PRIMARY KEY,
  `provider` VARCHAR(40) NOT NULL,
  `api_key_encrypted` TEXT,
  `base_url` VARCHAR(255) NOT NULL,
  `chat_model` VARCHAR(80) NOT NULL,
  `reasoning_model` VARCHAR(80),
  `thinking` VARCHAR(16) NOT NULL DEFAULT 'disabled',
  `reasoning_effort` VARCHAR(16) NOT NULL DEFAULT 'high',
  `max_tokens` INT NOT NULL DEFAULT 4096,
  `embedding_model` VARCHAR(80) NOT NULL,
  `updated_at` VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_llm_call_log` (
  `id` VARCHAR(64) PRIMARY KEY,
  `purpose` VARCHAR(32) NOT NULL,
  `user_id` BIGINT,
  `kb_id` BIGINT,
  `provider` VARCHAR(40) NOT NULL,
  `base_url` VARCHAR(255) NOT NULL,
  `model` VARCHAR(80) NOT NULL,
  `success` TINYINT NOT NULL,
  `status_code` INT,
  `duration_ms` INT NOT NULL,
  `prompt_tokens` INT,
  `completion_tokens` INT,
  `total_tokens` INT,
  `prompt_cache_hit_tokens` INT,
  `prompt_cache_miss_tokens` INT,
  `reasoning_tokens` INT,
  `finish_reason` VARCHAR(64),
  `error_message` TEXT,
  `created_at` VARCHAR(32) NOT NULL,
  INDEX `idx_llm_user` (`user_id`),
  INDEX `idx_llm_kb` (`kb_id`),
  INDEX `idx_llm_created_at` (`created_at`),
  INDEX `idx_llm_success` (`success`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_refresh_token` (
  `id` BIGINT PRIMARY KEY,
  `user_id` BIGINT NOT NULL,
  `token_hash` VARCHAR(128) NOT NULL UNIQUE,
  `expires_at` VARCHAR(32) NOT NULL,
  `revoked_at` VARCHAR(32),
  `replaced_by_token_hash` VARCHAR(128),
  `created_at` VARCHAR(32) NOT NULL,
  INDEX `idx_refresh_user` (`user_id`),
  INDEX `idx_refresh_expires_at` (`expires_at`),
  INDEX `idx_refresh_revoked_at` (`revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `aikb_audit_log` (
  `id` BIGINT PRIMARY KEY,
  `user_id` BIGINT,
  `action` VARCHAR(80) NOT NULL,
  `resource_type` VARCHAR(64),
  `resource_id` VARCHAR(80),
  `detail_json` JSON NOT NULL,
  `ip` VARCHAR(64),
  `user_agent` VARCHAR(255),
  `created_at` VARCHAR(32) NOT NULL,
  INDEX `idx_audit_user` (`user_id`),
  INDEX `idx_audit_action` (`action`),
  INDEX `idx_audit_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
