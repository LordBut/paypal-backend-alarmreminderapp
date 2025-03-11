package com.alarmreminderapp.backend

import android.util.Log
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.launch

class PayPalSubscriptionViewModel : ViewModel() {
  private val paypalClient = PayPalApiClient() // Uses PayPal API Client for API calls
  private val _subscriptionResponse = MutableLiveData<SubscriptionResponse?>()
  val subscriptionResponse: LiveData<SubscriptionResponse?> = _subscriptionResponse

  /**
   * Starts the PayPal subscription process.
   * Calls PayPal API to create a subscription and saves it in Firestore.
   */
  fun startSubscription(planId: String, tier: String) {
    val userId = FirebaseAuth.getInstance().currentUser?.uid
    if (userId == null) {
      Log.e("PayPalSubscription", "User not logged in")
      return
    }

    viewModelScope.launch {
      try {
        val response = paypalClient.createSubscription(planId, tier)

        if (response != null && response.subscriptionId.isNotEmpty()) {
          _subscriptionResponse.postValue(response)

          // Save subscription details to Firestore
          saveSubscriptionToFirestore(userId, tier, planId, response.subscriptionId)
        } else {
          Log.e("PayPalSubscription", "Failed to create subscription")
        }
      } catch (e: Exception) {
        Log.e("PayPalSubscription", "Subscription request failed: ${e.message}")
      }
    }
  }

  /**
   * Saves the subscription details to Firebase Firestore.
   */
  private fun saveSubscriptionToFirestore(userId: String, tier: String, planId: String?, subscriptionId: String?) {
    val db = FirebaseFirestore.getInstance()
    val subscriptionData = hashMapOf(
      "tier" to tier,
      "planId" to planId,
      "subscriptionId" to subscriptionId,
      "status" to if (subscriptionId != null) "active" else "free",
      "timestamp" to System.currentTimeMillis()
    )

    db.collection("users").document(userId)
      .collection("subscriptions").document("current")
      .set(subscriptionData)
      .addOnSuccessListener {
        Log.d("FIRESTORE", "Subscription successfully saved for user $userId")
      }
      .addOnFailureListener { e ->
        Log.e("FIRESTORE", "Error saving subscription: ${e.message}")
      }
  }

  /**
   * Checks the subscription status from PayPal.
   */
  fun checkSubscriptionStatus(subscriptionId: String) {
    viewModelScope.launch {
      try {
        val status = paypalClient.getSubscriptionStatus(subscriptionId)

        if (status != null) {
          Log.d("PayPalSubscription", "Subscription status: $status")

          // Update Firestore status
          val userId = FirebaseAuth.getInstance().currentUser?.uid
          if (userId != null) {
            updateSubscriptionStatusInFirestore(userId, subscriptionId, status)
          }
        }
      } catch (e: Exception) {
        Log.e("PayPalSubscription", "Error checking subscription status: ${e.message}")
      }
    }
  }

  /**
   * Updates the subscription status in Firestore.
   */
  private fun updateSubscriptionStatusInFirestore(userId: String, subscriptionId: String, status: String) {
    val db = FirebaseFirestore.getInstance()

    db.collection("users").document(userId)
      .collection("subscriptions").document("current")
      .update("status", status)
      .addOnSuccessListener {
        Log.d("FIRESTORE", "Subscription status updated: $status")
      }
      .addOnFailureListener { e ->
        Log.e("FIRESTORE", "Error updating subscription status: ${e.message}")
      }
  }
}
