-- Dedicated database for automated tests. Tests refuse to run against any
-- database whose name does not end in "_test".
CREATE DATABASE stockpulse_test OWNER stockpulse;
