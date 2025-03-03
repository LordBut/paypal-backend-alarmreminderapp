package com.alarmreminderapp.backend

import retrofit2.http.Body
import retrofit2.http.POST

interface BackendApi {
  @POST("create-subscription")
  suspend fun createSubscription(@Body request: SubscriptionRequest): SubscriptionResponse
}
