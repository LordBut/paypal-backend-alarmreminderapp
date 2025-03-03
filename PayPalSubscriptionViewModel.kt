package com.alarmreminderapp

import android.util.Log
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.alarmreminderapp.backend.SubscriptionRepository
import com.alarmreminderapp.backend.SubscriptionRequest
import com.alarmreminderapp.backend.SubscriptionResponse
import kotlinx.coroutines.launch

class PayPalSubscriptionViewModel : ViewModel() {
  private val repository = SubscriptionRepository()
  private val _subscriptionResponse = MutableLiveData<SubscriptionResponse?>()
  val subscriptionResponse: LiveData<SubscriptionResponse?> = _subscriptionResponse

  fun startSubscription(planId: String) {
    val request = SubscriptionRequest(planId)

    viewModelScope.launch {
      try {
        val response = repository.createSubscription(request.toString()) // Directly calling the suspend function
        _subscriptionResponse.postValue(response) // Update LiveData with the response
      } catch (e: Exception) {
        Log.e("API_ERROR", "Request failed: ${e.message}")
      }
    }
  }
}
