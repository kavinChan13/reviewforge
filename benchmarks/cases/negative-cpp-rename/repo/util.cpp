#include <vector>

int add(int a, int b) {
  int result = a + b;
  return result;
}

int sumAll(const std::vector<int>& xs) {
  int total = 0;
  for (int i = 0; i < static_cast<int>(xs.size()); ++i) {
    total += xs[i];
  }
  return total;
}
