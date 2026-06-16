#include <string>

const std::string &greeting(const std::string &name) {
  std::string msg = "Hello, " + name;
  return msg;
}
