#include <mutex>

struct Counter {
  int value = 0;
  std::mutex m;

  void inc() { value++; }

  int get() {
    std::lock_guard<std::mutex> g(m);
    return value;
  }
};
