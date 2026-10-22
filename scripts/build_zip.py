#!/usr/bin/env python3
import os
import zipfile

def package_project():
    exclude_dirs = {'node_modules', 'dist', '.git', '.cache', '.system_generated', '__pycache__'}
    exclude_files = {'neribo-project.zip', '.DS_Store'}
    output_zip = os.path.join('public', 'neribo-project.zip')
    
    os.makedirs('public', exist_ok=True)
    
    # Remove existing zip if present to build fresh
    if os.path.exists(output_zip):
        os.remove(output_zip)

    count = 0
    with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk('.'):
            # Modify dirs in-place to skip unwanted directories
            dirs[:] = [d for d in dirs if d not in exclude_dirs and not d.startswith('.')]
            
            for file in sorted(files):
                if file in exclude_files or file.endswith('.zip') or file.startswith('.'):
                    # Keep .env.example and .gitignore
                    if file not in {'.env.example', '.gitignore'}:
                        continue
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, '.')
                # Avoid archiving files from public that are large zips
                if rel_path == os.path.normpath(output_zip):
                    continue
                zipf.write(full_path, rel_path)
                count += 1

    size_kb = os.path.getsize(output_zip) / 1024
    print(f"Successfully packaged {count} files into {output_zip} ({size_kb:.1f} KB)")
    return output_zip

if __name__ == '__main__':
    package_project()
