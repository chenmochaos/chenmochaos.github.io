---
title: "Login登录功能设计"
slug: "login-double-interceptor"
description: "关于Login登录功能的设计思路讲解, 通过双拦截器实现用户登录态刷新, 并用redis实现集群模式下数据共享. 并且附带代码实现."
pubDate: 2026-10-22
updatedAt: 2026-10-23
tags: ["#java", "redis", "#业务功能"]
draft: false
syncedFrom: "STX/Code/Java/Login登录功能设计.md"
---

## Question

> Q1: 为什么用Redis? Redis作用是什么?

我们需要通过比对token进行登录校验, 那么token可以存在session里也可以存在redis里. 但是存在session中有一个弊端, 当我们有多台服务器时session是不共享的. 当然我们可以通过session拷贝来解决, 但是会造成**资源占用过多** 而且 session拷贝期间存在时间差, 可用性不好. 那么redis可以达到多态服务期间的资源共享, 而且存取速度快. 我们自然就选择用redis.

> Q2: 什么是ThreadLocal?

## 大致架构

### 登录

### 校验

