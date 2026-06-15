#include <mutex>
#include <vector>
#include <string>

namespace demo {

class Counter {
public:
  Counter() : value_(0) {}

  // BUG (concurrency): increments without holding the lock.
  void increment() { value_++; }

  int get() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return value_;
  }

private:
  int value_;
  mutable std::mutex mutex_;
};

// BUG (memory): returns a dangling pointer to a local.
const std::string* makeName() {
  std::string name = "temporary";
  return &name;
}

int sumFirstN(const std::vector<int>& xs, int n) {
  int total = 0;
  // BUG (correctness): off-by-one, reads xs[n].
  for (int i = 0; i <= n; ++i) {
    total += xs[i];
  }
  return total;
}

} // namespace demo
