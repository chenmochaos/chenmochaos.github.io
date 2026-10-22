/**
 * Supabase 连接配置。
 *
 * anon key 是设计上公开的：它会被打进每个访客下载的 JS 里，安全性来自数据库的
 * RLS 与「只能调用 increment_view 一个函数」的权限，而不是保密。所以直接写在这里
 * 并提交，本地开发和 CI 都不需要额外配置。
 *
 * 换项目 / 轮换 key 时改这个文件。
 */

export const SUPABASE_URL = 'https://cwbgwojnxlxonomofpar.supabase.co';

export const SUPABASE_ANON_KEY = 'sb_publishable_cKE5m3mrSD4Crv7a5ybDYg_UXeaWRe_';
