import sys

def replace_apple_with_banana(file_path):
    try:
        # Read the file contents
        with open(file_path, 'r', encoding='utf-8') as file:
            content = file.read()

        # Replace 'apple' with 'banana'
        new_content = content.replace('project', 'script')

        # Write the updated contents back to the file
        with open(file_path, 'w', encoding='utf-8') as file:
            file.write(new_content)

        print(f"Successfully replaced 'apple' with 'banana' in: {file_path}")

    except FileNotFoundError:
        print(f"Error: The file at '{file_path}' was not found.")
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python script.py <file_path>")
    else:
        replace_apple_with_banana(sys.argv[1])