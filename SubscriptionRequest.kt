package com.alarmreminderapp.backend

data class SubscriptionRequest(
  val plan_id: String,  // REQUIRED FIELD
  val subscriber: String = null.toString(),  // Optional field
  val start_time: String? = null  // Optional field
)

