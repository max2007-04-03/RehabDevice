Import("env")
import os
import shutil
import gzip

project_dir = env.subst("$PROJECT_DIR")
data_dir = os.path.join(project_dir, "data")
data_src_dir = os.path.join(project_dir, "data_src_temp")

def before_buildfs(source, target, env):
    print("\n[Auto-GZIP] Temporarily replacing 'data' with compressed files...")
    
    # 1. Rename original 'data' to 'data_src_temp'
    if os.path.exists(data_dir):
        os.rename(data_dir, data_src_dir)
    
    # 2. Create a new 'data' folder for mklittlefs
    os.makedirs(data_dir)
    
    for root, dirs, files in os.walk(data_src_dir):
        for file in files:
            file_path = os.path.join(root, file)
            rel_path = os.path.relpath(file_path, data_src_dir)
            
            if file.endswith((".html", ".css", ".js", ".json", ".svg", ".txt")):
                dest_path = os.path.join(data_dir, rel_path + ".gz")
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                with open(file_path, "rb") as f_in, gzip.open(dest_path, "wb") as f_out:
                    shutil.copyfileobj(f_in, f_out)
            else:
                dest_path = os.path.join(data_dir, rel_path)
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                shutil.copy2(file_path, dest_path)

def after_buildfs(source, target, env):
    print("\n[Auto-GZIP] Restoring original 'data' directory...")
    # 1. Remove the temporary compressed 'data' folder
    if os.path.exists(data_dir):
        shutil.rmtree(data_dir)
    
    # 2. Rename 'data_src_temp' back to 'data'
    if os.path.exists(data_src_dir):
        os.rename(data_src_dir, data_dir)
    print("[Auto-GZIP] Restoration complete.\n")

# Hook into the LittleFS build process
env.AddPreAction("$BUILD_DIR/littlefs.bin", before_buildfs)
env.AddPostAction("$BUILD_DIR/littlefs.bin", after_buildfs)
