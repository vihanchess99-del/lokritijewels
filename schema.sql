-- LOKRITI JEWELS by Aditi — current production schema reference.
-- The application applies versioned SQL from /migrations/ at startup.
-- No order/payment tables exist because the public site is view-only + enquiry.
CREATE TABLE schema_migrations (
  version VARCHAR(120) PRIMARY KEY,
  applied_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id VARCHAR(36) PRIMARY KEY,
  slug VARCHAR(220) NOT NULL UNIQUE,
  sku VARCHAR(80) NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  category VARCHAR(80) NOT NULL,
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock INT NOT NULL DEFAULT 0,
  description TEXT NULL,
  images JSON NOT NULL,
  image_alts JSON NOT NULL,
  badge VARCHAR(80) NULL,
  seo_title VARCHAR(255) NULL,
  seo_description VARCHAR(320) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  deleted_at DATETIME NULL,
  INDEX idx_products_category (category),
  INDEX idx_products_created (created_at),
  INDEX idx_products_deleted (deleted_at),
  FULLTEXT INDEX idx_products_search (name, category, description)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inquiries (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL,
  phone VARCHAR(40) NULL,
  message TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  status ENUM('new','read','closed') NOT NULL DEFAULT 'new',
  INDEX idx_inquiries_created (created_at),
  INDEX idx_inquiries_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rate_limits (
  bucket_key CHAR(64) PRIMARY KEY,
  window_start BIGINT NOT NULL,
  hit_count INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL,
  INDEX idx_rate_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
