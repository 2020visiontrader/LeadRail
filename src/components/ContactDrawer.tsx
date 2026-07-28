import { Contact } from '@/lib/types';
import { useState } from 'react';

interface ContactDrawerProps {
  contact: Contact | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdate?: (contact: Contact) => void;
}

export default function ContactDrawer({ contact, isOpen, onClose, onUpdate }: ContactDrawerProps) {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  if (!isOpen || !contact) return null;

  const handleEdit = (field: string, value: string) => {
    setEditingField(field);
    setEditValue(value);
  };

  const handleSave = () => {
    if (onUpdate && editingField) {
      onUpdate({ ...contact, [editingField]: editValue });
    }
    setEditingField(null);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-end z-50">
      <div className="w-full md:w-96 bg-white shadow-lg overflow-y-auto">
        <div className="p-6 border-b flex justify-between items-center sticky top-0 bg-white">
          <h2 className="text-lg font-bold">{contact.name}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-xl">✕</button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700">Name</label>
            {editingField === 'name' ? (
              <div className="flex gap-2 mt-1">
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="flex-1 px-3 py-2 border rounded"
                />
                <button onClick={handleSave} className="px-3 py-2 bg-blue-600 text-white rounded">Save</button>
              </div>
            ) : (
              <div className="flex justify-between items-center mt-1">
                <p>{contact.name}</p>
                <button
                  onClick={() => handleEdit('name', contact.name)}
                  className="text-blue-600 hover:underline text-sm"
                >
                  Edit
                </button>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700">Email</label>
            <p className="text-blue-600 mt-1">{contact.email}</p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700">Company</label>
            <p className="mt-1">{contact.company || '—'}</p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700">Segment</label>
            <span className="inline-block mt-1 px-3 py-1 bg-blue-100 text-blue-800 rounded text-sm">{contact.segment}</span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700">Score</label>
              <p className="text-lg font-bold text-green-600 mt-1">{contact.score}</p>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700">Status</label>
              <p className="mt-1">{contact.status}</p>
            </div>
          </div>

          <div className="border-t pt-4 mt-4">
            <h3 className="font-semibold text-sm mb-2">Engagement Timeline</h3>
            <div className="space-y-2 text-sm text-gray-600">
              <p>📧 Email opened — 2 days ago</p>
              <p>🔗 Link clicked — 3 days ago</p>
              <p>📧 Email sent — 4 days ago</p>
            </div>
          </div>

          <button className="w-full mt-6 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">
            Delete Contact
          </button>
        </div>
      </div>
    </div>
  );
}