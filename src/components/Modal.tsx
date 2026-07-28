interface ModalProps {
  isOpen: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
}

export default function Modal({ isOpen, title, children, onClose, onSubmit, submitLabel = 'Submit' }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="p-6 border-b flex justify-between items-center">
          <h2 className="text-xl font-bold">{title}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">✕</button>
        </div>
        <div className="p-6">
          {children}
        </div>
        <div className="p-6 border-t flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-gray-700 border border-gray-300 rounded hover:bg-gray-50">
            Cancel
          </button>
          {onSubmit && (
            <button onClick={onSubmit} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              {submitLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}