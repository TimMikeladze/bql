// The schema both typed tests use. types.test.ts checks what the parser infers from it;
// runtime.test.ts runs it and checks SQLite agrees.

import { schema } from "../../src/typed/index.ts"

export const app = schema(
  `create table users(
     id integer primary key,
     Name text not null,
     email text,
     created datetime default current_timestamp,
     avatar blob,
     meta
   )`,
  "create table posts(id integer primary key, user_id integer not null references users(id), title text not null, body text, score real)",
  "create table tags(k text primary key, v text) strict",
  "create table loose_pk(k int primary key, v varchar(20))",
  "alter table posts add column views integer not null default 0",
  "create view titles as select p.id, p.title, u.Name as author from posts p join users u on u.id = p.user_id",
  "create virtual table docs using fts5(title, body, tokenize = 'porter')",
)
