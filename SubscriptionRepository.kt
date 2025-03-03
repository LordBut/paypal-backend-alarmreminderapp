package com.alarmreminderapp.backend

import android.util.Log
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

class SubscriptionRepository {
  private val api: BackendApi = Retrofit.Builder()
    .baseUrl("https://paypal-api-khmg.onrender.com/") // Ensure correct API URL
    .addConverterFactory(GsonConverterFactory.create())
    .build()
    .create(BackendApi::class.java)

  suspend fun createSubscription(planId: String): SubscriptionResponse? {
    return try {
      val request = SubscriptionRequest(plan_id = planId)
      api.createSubscription(request)
    } catch (e: Exception) {
      Log.e("API_FAILURE", "Request failed: ${e.message}")
      null
    }
  }
}
