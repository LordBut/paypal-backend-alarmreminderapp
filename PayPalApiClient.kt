package com.alarmreminderapp.backend

import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class PayPalApiClient {

  companion object {
    private const val PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com" // Use live URL in production
    private const val CLIENT_ID = "YOUR_PAYPAL_CLIENT_ID"
    private const val CLIENT_SECRET = "YOUR_PAYPAL_CLIENT_SECRET"
    private const val TAG = "PayPalApiClient"
  }

  private val client = OkHttpClient.Builder()
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .build()

  /**
   * Retrieves an OAuth access token from PayPal.
   */
  private suspend fun getAccessToken(): String? {
    return withContext(Dispatchers.IO) {
      try {
        val credentials = Credentials.basic(CLIENT_ID, CLIENT_SECRET)
        val request = Request.Builder()
          .url("$PAYPAL_BASE_URL/v1/oauth2/token")
          .post("grant_type=client_credentials".toRequestBody("application/x-www-form-urlencoded".toMediaTypeOrNull()))
          .header("Authorization", credentials)
          .header("Accept", "application/json")
          .header("Content-Type", "application/x-www-form-urlencoded")
          .build()

        val response = client.newCall(request).execute()
        if (response.isSuccessful) {
          val jsonResponse = JSONObject(response.body?.string() ?: "")
          return@withContext jsonResponse.getString("access_token")
        } else {
          Log.e(TAG, "Error getting PayPal token: ${response.message}")
          return@withContext null
        }
      } catch (e: Exception) {
        Log.e(TAG, "Exception getting PayPal token: ${e.message}")
        return@withContext null
      }
    }
  }

  /**
   * Creates a PayPal subscription and returns the approval URL.
   */
  suspend fun createSubscription(planId: String, tier: String): SubscriptionResponse? {
    return withContext(Dispatchers.IO) {
      val accessToken = getAccessToken() ?: return@withContext null

      try {
        val requestBody = JSONObject().apply {
          put("plan_id", planId)
          put("subscriber", JSONObject().apply {
            put("email_address", FirebaseAuth.getInstance().currentUser?.email ?: "unknown@example.com")
          })
          put("application_context", JSONObject().apply {
            put("brand_name", "Alarm Reminder App")
            put("locale", "en-US")
            put("shipping_preference", "NO_SHIPPING")
            put("user_action", "SUBSCRIBE_NOW")
            put("return_url", "alarmreminderapp://subscription/success")
            put("cancel_url", "alarmreminderapp://subscription/cancel")
          })
        }

        val request = Request.Builder()
          .url("$PAYPAL_BASE_URL/v1/billing/subscriptions")
          .post(requestBody.toString().toRequestBody("application/json".toMediaTypeOrNull()))
          .header("Authorization", "Bearer $accessToken")
          .header("Content-Type", "application/json")
          .build()

        val response = client.newCall(request).execute()
        if (response.isSuccessful) {
          val jsonResponse = JSONObject(response.body?.string() ?: "")
          val approvalUrl = jsonResponse.getJSONArray("links")
            .let { links ->
              (0 until links.length())
                .map { links.getJSONObject(it) }
                .firstOrNull { it.getString("rel") == "approve" }
                ?.getString("href")
            }

          return@withContext SubscriptionResponse(
            subscriptionId = jsonResponse.getString("id"),
            approvalUrl = approvalUrl
          )
        } else {
          Log.e(TAG, "Error creating subscription: ${response.message}")
          return@withContext null
        }
      } catch (e: Exception) {
        Log.e(TAG, "Exception creating subscription: ${e.message}")
        return@withContext null
      }
    }
  }

  /**
   * Gets the status of a PayPal subscription.
   */
  suspend fun getSubscriptionStatus(subscriptionId: String): String? {
    return withContext(Dispatchers.IO) {
      val accessToken = getAccessToken() ?: return@withContext null

      try {
        val request = Request.Builder()
          .url("$PAYPAL_BASE_URL/v1/billing/subscriptions/$subscriptionId")
          .get()
          .header("Authorization", "Bearer $accessToken")
          .header("Content-Type", "application/json")
          .build()

        val response = client.newCall(request).execute()
        if (response.isSuccessful) {
          val jsonResponse = JSONObject(response.body?.string() ?: "")
          return@withContext jsonResponse.getString("status")
        } else {
          Log.e(TAG, "Error fetching subscription status: ${response.message}")
          return@withContext null
        }
      } catch (e: Exception) {
        Log.e(TAG, "Exception fetching subscription status: ${e.message}")
        return@withContext null
      }
    }
  }

  suspend fun CheckSubscriptionStatus(subscriptionId: String): Boolean {
    return withContext(Dispatchers.IO) {
      val status = getSubscriptionStatus(subscriptionId)
      Log.d(TAG, "Subscription status: $status")

      return@withContext status == "ACTIVE" // Returns true if the subscription is active
    }
  }
}


