import java.io.FileInputStream;

class Reader {
  int first(String path) throws Exception {
    FileInputStream in = new FileInputStream(path);
    return in.read();
  }
}
